import { z } from "zod";

export const spacePillarVersionSchema = z.object({
  version: z.string().min(1),
  name: z.string().optional(),
  packages: z.array(z.string()).optional(),
  platforms: z.array(z.string()).optional(),
  platform: z.string().optional(),
  manifest: z.string().optional(),
  npm: z.string().optional(),
  command: z.string().optional()
});

export const spaceVersionManifestSchema = z.object({
  $schema: z.string().optional(),
  platform: z.object({
    version: z.string().min(1),
    codename: z.string().optional(),
    releaseDate: z.string().optional(),
    gitCommit: z.string().optional()
  }),
  pillars: z.object({
    core: spacePillarVersionSchema,
    desktop: spacePillarVersionSchema,
    mobile: spacePillarVersionSchema,
    setup: spacePillarVersionSchema
  }),
  compatibility: z.object({
    minDesktopClient: z.string().optional(),
    minMobileClient: z.string().optional(),
    minSetupCli: z.string().optional()
  }).optional()
});

export type SpacePillarVersion = z.infer<typeof spacePillarVersionSchema>;
export type SpaceVersionManifest = z.infer<typeof spaceVersionManifestSchema>;

export interface SpacePlatformSummary {
  version: string;
  codename?: string;
  releaseDate?: string;
  gitCommit?: string;
  pillars: {
    core: string;
    desktop: string;
    mobile: string;
    setup: string;
  };
}
