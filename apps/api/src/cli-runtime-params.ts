/**
 * Route parameter schema shared by the CLI runtime, settings and account routes (moved verbatim from the composition
 * root).
 */
import { z } from "zod";
import { cliToggleRuntimeIdSchema } from "@space/contracts";

export const cliRuntimeSettingParamSchema = z.object({ runtimeId: cliToggleRuntimeIdSchema });
