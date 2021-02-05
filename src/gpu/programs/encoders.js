/*
 * speedy-vision.js
 * GPU-accelerated Computer Vision for JavaScript
 * Copyright 2020-2021 Alexandre Martins <alemartf(at)gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * encoders.js
 * Texture encoders
 */

import { SpeedyProgramGroup } from '../speedy-program-group';
import { importShader } from '../shader-declaration';
import { SpeedyFeature } from '../../core/speedy-feature';
import { PixelComponent } from '../../utils/types';
import { Utils } from '../../utils/utils'
import { SpeedyPromise } from '../../utils/speedy-promise'
import { IllegalOperationError, NotSupportedError } from '../../utils/errors';
import {
    PYRAMID_MAX_LEVELS, LOG2_PYRAMID_MAX_SCALE,
    FIX_RESOLUTION, MAX_TEXTURE_LENGTH,
    KPF_ORIENTED, KPF_DISCARD,
    MAX_DESCRIPTOR_SIZE, MIN_KEYPOINT_SIZE,
} from '../../utils/globals';

// We won't admit more than MAX_KEYPOINTS per media.
// The larger this value is, the more data we need to transfer from the GPU.
const MIN_PIXELS_PER_KEYPOINT = MIN_KEYPOINT_SIZE / 4; // encodes a keypoint header
const MIN_ENCODER_LENGTH = 16; // storage for 16*16/MIN_PIXELS_PER_KEYPOINT <= 128 keypoints
const MAX_ENCODER_LENGTH = 300; // in pixels (if too large, WebGL may lose context - so be careful!)
const INITIAL_ENCODER_LENGTH = MIN_ENCODER_LENGTH; // pick a small number to reduce processing load and not crash things on mobile (WebGL lost context)
const MAX_KEYPOINTS = 8192; // can't detect more than this number of keypoints per frame
const UBO_MAX_BYTES = 16384; // UBOs can hold at least 16KB of data: gl.MAX_UNIFORM_BLOCK_SIZE >= 16384 according to the GL ES 3 reference
const KEYPOINT_BUFFER_LENGTH = (UBO_MAX_BYTES / 16) | 0; // maximum number of keypoints that can be uploaded to the GPU via UBOs (each keypoint uses 16 bytes)
const ENCODER_PASSES = 8; // number of passes of the keypoint encoder: directly impacts performance
const LONG_SKIP_OFFSET_PASSES = 2; // number of passes of the long skip offsets shader
const MAX_SKIP_OFFSET_ITERATIONS = [ 32, 32 ]; // used when computing skip offsets




//
// Shaders
//

// encode keypoint offsets: maxIterations is an experimentally determined integer
const encodeKeypointSkipOffsets = importShader('encoders/encode-keypoint-offsets.glsl')
                                 .withArguments('image', 'imageSize')
                                 .withDefines({ 'MAX_ITERATIONS': MAX_SKIP_OFFSET_ITERATIONS[0] });

// encode long offsets for improved performance
const encodeKeypointLongSkipOffsets = importShader('encoders/encode-keypoint-long-offsets.glsl')
                                     .withArguments('offsetsImage', 'imageSize')
                                     .withDefines({ 'MAX_ITERATIONS': MAX_SKIP_OFFSET_ITERATIONS[1] });

// encode keypoints
const encodeKeypoints = importShader('encoders/encode-keypoints.glsl')
                       .withArguments('offsetsImage', 'encodedKeypoints', 'imageSize', 'passId', 'numPasses', 'descriptorSize', 'extraSize', 'encoderLength');

// resize encoded keypoints
const resizeEncodedKeypoints = importShader('encoders/resize-encoded-keypoints.glsl')
                              .withArguments('inputTexture', 'inputDescriptorSize', 'inputExtraSize', 'inputEncoderLength', 'outputDescriptorSize', 'outputExtraSize', 'outputEncoderLength');

// helper for downloading the keypoints
const downloadKeypoints = importShader('utils/identity.glsl')
                         .withArguments('image');

// upload keypoints via UBO
const uploadKeypoints = importShader('encoders/upload-keypoints.glsl')
                       .withArguments('keypointCount', 'encoderLength', 'descriptorSize', 'extraSize')
                       .withDefines({
                           'KEYPOINT_BUFFER_LENGTH': KEYPOINT_BUFFER_LENGTH
                       });




/**
 * GPUEncoders
 * Keypoint encoding
 */
export class GPUEncoders extends SpeedyProgramGroup
{
    /**
     * Class constructor
     * @param {SpeedyGPU} gpu
     * @param {number} width
     * @param {number} height
     */
    constructor(gpu, width, height)
    {
        super(gpu, width, height);
        this
            // encode skip offsets
            .declare('_encodeKeypointSkipOffsets', encodeKeypointSkipOffsets)
            .declare('_encodeKeypointLongSkipOffsets', encodeKeypointLongSkipOffsets, {
                ...this.program.usesPingpongRendering()
            })

            // tiny textures
            .declare('_encodeKeypoints', encodeKeypoints, {
                ...this.program.hasTextureSize(INITIAL_ENCODER_LENGTH, INITIAL_ENCODER_LENGTH),
                ...this.program.usesPingpongRendering()
            })
            .declare('_resizeEncodedKeypoints', resizeEncodedKeypoints, {
                ...this.program.hasTextureSize(INITIAL_ENCODER_LENGTH, INITIAL_ENCODER_LENGTH)
            })
            .declare('_downloadKeypoints', downloadKeypoints, {
                ...this.program.hasTextureSize(INITIAL_ENCODER_LENGTH, INITIAL_ENCODER_LENGTH)
            })
            .declare('_uploadKeypoints', uploadKeypoints, {
                ...this.program.hasTextureSize(INITIAL_ENCODER_LENGTH, INITIAL_ENCODER_LENGTH)
            })
        ;



        // setup internal data

        /** @type {number} length of the tiny encoding textures */
        this._encoderLength = INITIAL_ENCODER_LENGTH;

        /** @type {number} how many keypoints we can encode at the moment */
        this._keypointCapacity = (INITIAL_ENCODER_LENGTH * INITIAL_ENCODER_LENGTH / MIN_KEYPOINT_SIZE) | 0;

        /** @type {Float32Array} UBO stuff */
        this._uploadBuffer = null; // lazy spawn
    }

    /**
     * Keypoint encoder length
     * @returns {number}
     */
    get encoderLength()
    {
        return this._encoderLength;
    }

    /**
     * Optimizes the keypoint encoder for an expected number of keypoints
     * @param {number} maxKeypointCount expected maximum number of keypoints
     * @param {number} descriptorSize in bytes
     * @param {number} extraSize in bytes
     * @returns {boolean} true if the encoder has been optimized
     */
    optimize(maxKeypointCount, descriptorSize, extraSize)
    {
        const keypointCapacity = Math.ceil(maxKeypointCount); // ensure this is an integer
        const newEncoderLength = this._minimumEncoderLength(keypointCapacity, descriptorSize, extraSize);
        const oldEncoderLength = this._encoderLength;

        this._encoderLength = newEncoderLength;
        this._keypointCapacity = keypointCapacity;

        return (newEncoderLength - oldEncoderLength) != 0;
    }

    /**
     * Ensures that the encoder has enough capacity to deliver the specified number of keypoints
     * @param {number} keypointCapacity the number of keypoints
     * @param {number} descriptorSize in bytes
     * @param {number} extraSize in bytes
     * @returns {boolean} true if there was any change to the length of the encoder
     */
    reserveSpace(keypointCapacity, descriptorSize, extraSize)
    {
        // resize if not enough space
        if(this._minimumEncoderLength(keypointCapacity, descriptorSize, extraSize) > this._encoderLength)
            return this.optimize(keypointCapacity, descriptorSize, extraSize);

        return false;
    }

    /**
     * Encodes the keypoints of an image into a compressed texture
     * @param {SpeedyTexture} corners texture with corners
     * @param {number} descriptorSize in bytes
     * @param {number} extraSize in bytes
     * @returns {SpeedyTexture} texture with encoded keypoints
     */
    encodeKeypoints(corners, descriptorSize, extraSize)
    {
        // parameters
        const encoderLength = this._encoderLength;
        const imageSize = [ this._width, this._height ];

        // encode skip offsets
        let offsets = this._encodeKeypointSkipOffsets(corners, imageSize);
        for(let i = 0; i < LONG_SKIP_OFFSET_PASSES; i++) // meant to boost performance
            offsets = this._encodeKeypointLongSkipOffsets(offsets, imageSize);

        /*
        // debug: view corners
        let cornerview = corners;
        cornerview = this._gpu.programs.utils.fillComponents(cornerview, PixelComponent.GREEN, 0);
        cornerview = this._gpu.programs.utils.identity(cornerview);
        cornerview = this._gpu.programs.utils.fillComponents(cornerview, PixelComponent.ALPHA, 1);
        this._gpu.programs.utils.output(cornerview);
        if(!window._ww) document.body.appendChild(this._gpu.canvas);
        window._ww = 1;
        */

        // encode keypoints
        const numPasses = ENCODER_PASSES;
        const pixelsPerKeypointHeader = MIN_PIXELS_PER_KEYPOINT;
        const headerEncoderLength = Math.max(MIN_ENCODER_LENGTH, Math.ceil(Math.sqrt(this._keypointCapacity * pixelsPerKeypointHeader)));
        this._encodeKeypoints.resize(headerEncoderLength, headerEncoderLength);
        let encodedKeypointHeaders = this._encodeKeypoints.clear(0, 0, 0, 0);
        for(let passId = 0; passId < numPasses; passId++)
            encodedKeypointHeaders = this._encodeKeypoints(offsets, encodedKeypointHeaders, imageSize, passId, numPasses, 0, 0, headerEncoderLength);

        // transfer keypoints to a elastic tiny texture with storage for descriptors & extra data
        this._resizeEncodedKeypoints.resize(encoderLength, encoderLength);
        return this._resizeEncodedKeypoints(encodedKeypointHeaders, 0, 0, headerEncoderLength, descriptorSize, extraSize, encoderLength);
    }

    /**
     * Decodes the keypoints, given a flattened image of encoded pixels
     * @param {Uint8Array[]} pixels pixels in the [r,g,b,a,...] format
     * @param {number} descriptorSize in bytes
     * @param {number} extraSize in bytes
     * @returns {SpeedyFeature[]} keypoints
     */
    decodeKeypoints(pixels, descriptorSize, extraSize)
    {
        const pixelsPerKeypoint = (MIN_KEYPOINT_SIZE + descriptorSize + extraSize) / 4;
        let x, y, lod, rotation, score, flags, extraBytes, descriptorBytes;
        let hasLod, hasRotation;
        const keypoints = [];

        // how many bytes should we read?
        const e = this._encoderLength;
        const e2 = e * e * pixelsPerKeypoint * 4;
        const size = Math.min(pixels.length, e2);

        // for each encoded keypoint
        for(let i = 0; i < size; i += 4 /* RGBA */ * pixelsPerKeypoint) {
            // extract fixed-point coordinates
            x = (pixels[i+1] << 8) | pixels[i];
            y = (pixels[i+3] << 8) | pixels[i+2];
            if(x >= 0xFFFF && y >= 0xFFFF) // if end of list
                break;

            // We've cleared the texture to black.
            // Likely to be incorrect black pixels
            // due to resize. Bad for encoderLength
            if(x + y == 0 && pixels[i+6] == 0)
                continue; // discard, it's noise

            // convert from fixed-point
            x /= FIX_RESOLUTION;
            y /= FIX_RESOLUTION;

            // extract flags
            flags = pixels[i+7];

            // extract LOD
            hasLod = (pixels[i+4] < 255);
            lod = !hasLod ? 0.0 :
                -LOG2_PYRAMID_MAX_SCALE + (LOG2_PYRAMID_MAX_SCALE + PYRAMID_MAX_LEVELS) * pixels[i+4] / 255.0;

            // extract orientation
            hasRotation = (flags & KPF_ORIENTED != 0);
            rotation = !hasRotation ? 0.0 :
                ((2 * pixels[i+5]) / 255.0 - 1.0) * Math.PI;

            // extract score
            score = pixels[i+6] / 255.0;

            // extra bytes
            extraBytes = (extraSize > 0) ? new Uint8Array(
                pixels.slice(8 + i, 8 + i + extraSize)
            ) : null;

            // descriptor bytes
            descriptorBytes = (descriptorSize > 0) ? new Uint8Array(
                pixels.slice(8 + i + extraSize, 8 + i + extraSize + descriptorSize)
            ) : null;

            // something is off with the encoder length
            if(
                (descriptorSize > 0 && descriptorBytes.length < descriptorSize) ||
                (extraSize > 0 && extraBytes.length < extraSize)
            )
                continue; // discard

            // register keypoint
            keypoints.push(
                new SpeedyFeature(x, y, lod, rotation, score, flags, extraBytes, descriptorBytes)
            );
        }

        /*
        // developer's secret ;)
        // reset the tuner
        if(keypoints.length == 0) {
            if(this._tuner.finished())
                this._tuner.reset();
        }
        */

        // done!
        return keypoints;
    }

    /**
     * Download RAW encoded keypoint data from the GPU - this is a bottleneck!
     * @param {SpeedyTexture} encodedKeypoints texture with keypoints that have already been encoded
     * @param {boolean} [useBufferedDownloads] download keypoints detected in the previous framestep (optimization)
     * @returns {SpeedyPromise<Uint8Array[]>} pixels in the [r,g,b,a, ...] format
     */
    downloadEncodedKeypoints(encodedKeypoints, useBufferedDownloads = true)
    {
        // helper shader for reading the data
        this._downloadKeypoints.resize(this._encoderLength, this._encoderLength);
        this._downloadKeypoints(encodedKeypoints);

        // read data from the GPU
        return this._downloadKeypoints.readPixelsAsync(useBufferedDownloads).catch(err => {
            return new IllegalOperationError(`Can't download encoded keypoint texture`, err);
        });
    }

    /**
     * Upload keypoints to the GPU
     * The descriptor & orientation of the keypoints will be lost
     * (need to recalculate)
     * @param {SpeedyFeature[]} keypoints
     * @param {number} descriptorSize in bytes
     * @param {number} extraSize in bytes
     * @returns {SpeedyTexture} encodedKeypoints
     */
    uploadKeypoints(keypoints, descriptorSize, extraSize)
    {
        // Too many keypoints?
        const keypointCount = keypoints.length;
        if(keypointCount > KEYPOINT_BUFFER_LENGTH) {
            // TODO: multipass
            throw new NotSupportedError(`Can't upload ${keypointCount} keypoints: maximum is currently ${KEYPOINT_BUFFER_LENGTH}`);
        }

        // Create a buffer for uploading the data
        if(this._uploadBuffer === null) {
            const sizeofVec4 = Float32Array.BYTES_PER_ELEMENT * 4; // 16
            const internalBuffer = new ArrayBuffer(sizeofVec4 * KEYPOINT_BUFFER_LENGTH);
            Utils.assert(internalBuffer.byteLength <= UBO_MAX_BYTES);
            this._uploadBuffer = new Float32Array(internalBuffer);
        }

        // Format data as follows: (xpos, ypos, lod, score)
        for(let i = 0; i < keypointCount; i++) {
            const keypoint = keypoints[i];
            const j = i * 4;

            // this will be uploaded into a vec4
            this._uploadBuffer[j]   = +(keypoint.x) || 0;
            this._uploadBuffer[j+1] = +(keypoint.y) || 0;
            this._uploadBuffer[j+2] = +(keypoint.lod) || 0;
            this._uploadBuffer[j+3] = +(keypoint.score) || 0;
        }

        // Reserve space for the keypoints
        this.reserveSpace(keypointCount, descriptorSize, extraSize);

        // Upload data
        this._uploadKeypoints.resize(this._encoderLength, this._encoderLength);
        this._uploadKeypoints.setUBO('KeypointBuffer', this._uploadBuffer);
        return this._uploadKeypoints(keypointCount, this._encoderLength, descriptorSize, extraSize);
    }

    /**
     * The minimum encoder length for a set of keypoints
     * @param {number} keypointCount
     * @param {number} descriptorSize
     * @param {number} extraSize
     * @returns {number} between 1 and MAX_ENCODER_LENGTH
     */
    _minimumEncoderLength(keypointCount, descriptorSize, extraSize)
    {
        const clampedKeypointCount = Math.max(0, Math.min(Math.ceil(keypointCount), MAX_KEYPOINTS));
        const pixelsPerKeypoint = Math.ceil((MIN_KEYPOINT_SIZE + descriptorSize + extraSize) / 4);
        const len = Math.ceil(Math.sqrt(clampedKeypointCount * pixelsPerKeypoint));

        return Math.max(MIN_ENCODER_LENGTH, Math.min(len, MAX_ENCODER_LENGTH));
    }
}