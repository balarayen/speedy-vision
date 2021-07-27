/*
 * speedy-vision.js
 * GPU-accelerated Computer Vision for JavaScript
 * Copyright 2021 Alexandre Martins <alemartf(at)gmail.com>
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
 * speedy-keypoint-descriptor.js
 * Keypoint descriptor
 */

/**
 * Represents a keypoint descriptor
 */
export class SpeedyKeypointDescriptor
{
    /**
     * Constructor
     * @param {Uint8Array} data descriptor bytes
     */
    constructor(data)
    {
        this._data = data;
        return Object.freeze(this);
    }

    /**
     * Descriptor data
     * @returns {Uint8Array}
     */
    get data()
    {
        return this._data;
    }

    /**
     * The size of the descriptor, in bytes
     * @returns {number}
     */
    get size()
    {
        return this._data.byteLength;
    }

    /**
     * A string representation of the keypoint descriptor
     * @returns {string}
     */
    toString()
    {
        return `SpeedyKeypointDescriptor(${this._data.join(',')})`;
    }
}