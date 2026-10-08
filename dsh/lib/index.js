import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apply as skillFilesystemApply,
  Config as skillFilesystemConfig,
  inject as skillFilesystemInject,
  name as skillFilesystemName,
} from "@deepseek-ai/dsh-skill-filesystem";

export const name = "explainer-video-from-coursework-dsh";
export const inject = ["skills"];

const SkillFilesystem = {
  name: skillFilesystemName,
  inject: skillFilesystemInject,
  Config: skillFilesystemConfig,
  apply: skillFilesystemApply,
};

export function apply(ctx) {
  // This module lives in <pkg>/lib; the bundled skill lives in <pkg>/skills.
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
  ctx.plugin(SkillFilesystem, {
    // A unique provider name: the base bundle already registers a "filesystem"
    // provider in the same (global) layer, and duplicate names would throw.
    providerName: "explainer-video-from-coursework-dsh",
    includeDefaultRoots: false,
    customSkillDirs: [skillsDir],
  });
}
