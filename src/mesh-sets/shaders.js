const common = `
#include <common>

uniform float zoom;
uniform float cameraZ;
uniform float modelScale;
uniform float carLift;
uniform float busLift;
uniform sampler2D textureData0;
uniform sampler2D textureData1;
uniform sampler2D textureColor;

attribute int instanceID;

#ifdef LONDON_TUBE
attribute float partRole;
varying float vTubePart;
varying vec3 vTubePosition;
varying float vTubeShade;
#endif

#ifndef BUS
attribute float groupIndex;
#endif

float getScale( float zoom, float modelScale) {
    return pow( 2.0, 14.0 - clamp( zoom, 13.0, 19.0 ) ) * modelScale * 100.0;
}

#ifndef BUS
mat3 rotateX( float angle ) {
    float s = sin( angle );
    float c = cos( angle );
    return mat3(
        1.0, 0.0, 0.0,
        0.0, c, s,
        0.0, -s, c
    );
}
#endif

mat3 rotateZ( float angle ) {
    float s = sin( angle );
    float c = cos( angle );
    return mat3(
        c, s, 0.0,
        -s, c, 0.0,
        0.0, 0.0, 1.0
    );
}

varying vec3 vInstanceColor;
varying float vInstanceOpacity;
`;

const colorVertex = `
#include <color_vertex>

int width = textureSize( textureData0, 0 ).x;
ivec2 reference = ivec2( instanceID % width, instanceID / width );
vec4 data0 = texelFetch( textureData0, reference, 0 );
vec4 data1 = texelFetch( textureData1, reference, 0 );
vec3 translation = data0.xyz;
int colorID = int( data0.w );
float rotationX = data1.y;
float rotationZ = data1.x;
float opacity0 = data1.w;

width = textureSize( textureColor, 0 ).x;
reference = ivec2( colorID * 4 % width, colorID * 4 / width );
vec3 color0 = texelFetch( textureColor, reference, 0 ).rgb;
reference = ivec2( ( colorID * 4 + 1 ) % width, ( colorID * 4 + 1 ) / width );
vec3 color1 = texelFetch( textureColor, reference, 0 ).rgb;
reference = ivec2( ( colorID * 4 + 2 ) % width, ( colorID * 4 + 2 ) / width );
vec3 color2 = texelFetch( textureColor, reference, 0 ).rgb;
reference = ivec2( ( colorID * 4 + 3 ) % width, ( colorID * 4 + 3 ) / width );
vec3 color3 = texelFetch( textureColor, reference, 0 ).rgb;

#ifdef CAR
#ifdef LONDON_TUBE
vTubePart = partRole;
vTubePosition = position;
vTubeShade = 0.86 + 0.14 * max( normal.z, 0.0 );
vInstanceColor = partRole < 0.5 ? vec3( 0.98, 0.99, 1.0 ) :
    partRole < 1.5 ? vec3( 0.045, 0.075, 0.11 ) :
    partRole < 2.5 ? color0 :
    partRole < 3.5 ? vec3( 0.150, 0.165, 0.180 ) :
    vec3( 0.86, 0.035, 0.065 );
#else
float mod3 = mod( groupIndex, 3.0 );
vec3 null = vec3( 0.0, 1.0, 0.0 );
vInstanceColor = groupIndex >= 3.0 && color3 != null ? color3 : mod3 == 0.0 ? color0 : mod3 == 1.0 ? color1 : color2;
#endif
#endif

#ifdef AIRCRAFT
vInstanceColor = groupIndex < 2.0 ? color0 : color1;
#endif

#ifdef BUS
vInstanceColor = color0;
#endif

vInstanceOpacity = opacity0;
`;

const beginNormalVertex = `
#ifdef BUS
vec3 objectNormal = rotateZ( rotationZ ) * vec3( normal );
#else
vec3 objectNormal = rotateZ( rotationZ ) * rotateX( rotationX ) * vec3( normal );
#endif
`;

const transformPosition = `
float zoom0 = zoom + log2( cameraZ / abs( cameraZ - translation.z ) );
float scale0 = getScale( zoom0, modelScale );

#ifdef AIRCRAFT
float scale = 0.06 / 0.285 * modelScale * 100.0;
float offsetY = groupIndex == 2.0 ? 0.44 - 1.32 * max( scale / scale0, 1.0 ) : 0.0;
float offsetZ = groupIndex == 2.0 ? 0.88 : 0.0;
float scaleX = groupIndex == 1.0 ? max( scale0, scale ) : scale0;
float scaleY = groupIndex == 0.0 ? max( scale0, scale ) : scale0;
vec3 position0 = ( position + vec3( 0.0, offsetY, offsetZ ) ) * vec3( scaleX, scaleY, scale0 );
#else
vec3 position0 = position * scale0;
#endif

position0 = position0 * ( 1.0 + float( instanceID % 256 ) / 256.0 * 0.03 );

#ifdef BUS
vec3 transformed = rotateZ( rotationZ ) * position0 + translation + vec3( 0.0, 0.0, busLift * scale0 );
#else
vec3 transformed = rotateZ( rotationZ ) * rotateX( rotationX ) * position0 + translation + vec3( 0.0, 0.0, carLift * scale0 );
#endif
`;

export function updateVertexShader(shader) {
    return shader
        .replace('#include <common>', common)
        .replace('#include <color_vertex>', colorVertex)
        .replace('#include <beginnormal_vertex>', beginNormalVertex)
        .replace('#include <begin_vertex>', transformPosition);
}

const packing = `
#include <packing>

#ifdef LONDON_TUBE
varying float vTubePart;
varying vec3 vTubePosition;
varying float vTubeShade;
#endif

varying vec3 vInstanceColor;
varying float vInstanceOpacity;
`;

const diffuseColorFragment = `
vec4 diffuseColor = vec4( diffuse * vInstanceColor, opacity * vInstanceOpacity );
`;

// Crisp painted details in model space: no texture downloads or extra meshes.
// Illustration lighting keeps white roofs readable independently of camera bearing.
const londonTubeLightFragment = `
#ifdef LONDON_TUBE
vec3 paint = diffuseColor.rgb;
float carriageY = mod( vTubePosition.y + 0.22, 0.44 ) - 0.22;
float edge = max( fwidth( carriageY ), 0.001 );
if ( vTubePart < 0.5 ) {
    float roof = smoothstep( 0.10, 0.13, vTubePosition.z );
    float panel = ( 1.0 - smoothstep( 0.064, 0.064 + edge, abs( vTubePosition.x ) ) ) *
        ( 1.0 - smoothstep( 0.12, 0.12 + edge, abs( carriageY ) ) );
    paint = mix( paint, vec3( 0.66, 0.72, 0.79 ), roof * panel * 0.65 );
    // Dark roof seams make the white silhouette legible on pale buildings.
    float rim = smoothstep( 0.095, 0.095 + edge, abs( vTubePosition.x ) );
    float seam = smoothstep( 0.184, 0.184 + edge, abs( carriageY ) );
    paint = mix( paint, vec3( 0.12, 0.18, 0.25 ), roof * max( rim, seam ) );
    float cab = smoothstep( 0.585, 0.60, abs( vTubePosition.y ) );
    paint = mix( paint, vec3( 0.86, 0.035, 0.065 ), roof * cab );
} else if ( vTubePart < 1.5 && abs( vTubePosition.y ) < 0.64 ) {
    float pillar = 1.0 - smoothstep( 0.009, 0.009 + edge, abs( abs( carriageY ) - 0.045 ) );
    paint = mix( paint, vec3( 0.96, 0.98, 1.0 ), pillar );
}
outgoingLight = paint * vTubeShade;
#endif
#include <opaque_fragment>
`;

export function updateFragmentShader(shader) {
    return shader
        .replace('#include <packing>', packing)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', diffuseColorFragment)
        .replace('#include <opaque_fragment>', londonTubeLightFragment);
}

// Clip-space offsets keep decluttering in CSS pixels at every zoom and pitch.
// Used unchanged by the visible, GPU-picking, outline and delay-marker passes.
export function offsetLondonTrainVertexShader(shader) {
    return `attribute vec2 londonOffset;\n${shader}`.replace(/}\s*$/, `
    gl_Position.xy += londonOffset * gl_Position.w;
}`);
}
