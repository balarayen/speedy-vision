uniform sampler2D image;
uniform float imageScale;

#define B2(expr) bvec2((expr),(expr))

// normalize keypoint positions, so that they are
// positioned as if scale = 1.0 (base of the pyramid)
// this assumes 1 < imageScale <= 2
void main()
{
    ivec2 thread = threadLocation();
    ivec2 size = outputSize();
    ivec2 scaled = ivec2((texCoord * texSize) * imageScale);
    ivec2 imageSize = textureSize(image, 0);
    vec4 pixel = threadPixel(image);
    vec4 p0 = pixelAt(image, min(scaled, imageSize-1));
    vec4 p1 = pixelAt(image, min(scaled + ivec2(0, 1), imageSize-1));
    vec4 p2 = pixelAt(image, min(scaled + ivec2(1, 0), imageSize-1));
    vec4 p3 = pixelAt(image, min(scaled + ivec2(1, 1), imageSize-1));

    // locate corner in a 2x2 square (p0...p3)
    // if there is a corner, take the scale & score of the one with the maximum score
    // if there is no corner in the 2x2 square, drop the corner
    bool gotCorner = ((thread.x & 1) + (thread.y & 1) == 0) && // x and y are even
        (scaled.x + 1 < size.x && scaled.y + 1 < size.y) && // square is within bounds
        (p0.r + p1.r + p2.r + p3.r > 0.0f); // there is a corner
    /*
    vec2 best = mix(
        vec2(0.0f, pixel.a), // drop corner
        mix(
            mix(
                mix(p3.ra, p1.ra, B2(p1.r > p3.r)),
                mix(p2.ra, p1.ra, B2(p1.r > p2.r)),
                B2(p2.r > p3.r)
            ),
            mix(
                mix(p3.ra, p0.ra, B2(p0.r > p3.r)),
                mix(p2.ra, p0.ra, B2(p0.r > p2.r)),
                B2(p2.r > p3.r)
            ),
            B2(p0.r > p1.r)
        ),
        B2(gotCorner)
    );
    */
    float m, s;
            // get scale & score of the maximum
            if(p0.r > p1.r) {
                if(p2.r > p3.r) {
                    if(p0.r > p2.r) {
                        m = p0.r;
                        s = p0.a;
                    }
                    else {
                        m = p2.r;
                        s = p2.a;
                    }
                }
                else {
                    if(p0.r > p3.r) {
                        m = p0.r;
                        s = p0.a;
                    }
                    else {
                        m = p3.r;
                        s = p3.a;
                    }                   
                }
            }
            else {
                if(p2.r > p3.r) {
                    if(p1.r > p2.r) {
                        m = p1.r;
                        s = p1.a;
                    }
                    else {
                        m = p2.r;
                        s = p2.a;
                    }
                }
                else {
                    if(p1.r > p3.r) {
                        m = p1.r;
                        s = p1.a;
                    }
                    else {
                        m = p3.r;
                        s = p3.a;
                    }                   
                }               
            }
    vec2 best = vec2(m,s);

    // done
    color = vec4(best.x, pixel.gb, best.y);
}