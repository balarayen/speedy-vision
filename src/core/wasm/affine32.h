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
 * affine32.h
 * Affine transform
 */

#ifndef _AFFINE32_H
#define _AFFINE32_H

#include "base.h"

const Mat32* Mat32_affine_dlt3(const Mat32* result, const Mat32* src, const Mat32* dest);
const Mat32* Mat32_affine_dlt(const Mat32* result, const Mat32* src, const Mat32* dest);

#endif