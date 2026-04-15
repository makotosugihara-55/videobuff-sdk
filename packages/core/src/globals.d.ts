/**
 * Re-export the global Window.videobuff augmentation from contracts.
 * This file exists because tsup --dts does not propagate `declare global`
 * blocks through bundled .d.ts output.
 */

/// <reference path="../../contracts/src/globals.d.ts" />
