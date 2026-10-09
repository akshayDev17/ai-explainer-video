import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

/** The published skill package this wrapper serves (a declared dependency). */
const SKILL_PACKAGE = "explainer-video-from-coursework";

export function apply(ctx) {
  // No skill files are bundled here: this wrapper depends on the skill package
  // and serves its installed skills/ directory, so the two npm packages cannot
  // drift out of step. Resolution starts at <pkg>/lib and walks node_modules.
  const require = createRequire(import.meta.url);
  const skillsDir = join(dirname(require.resolve(`${SKILL_PACKAGE}/package.json`)), "skills");
  ctx.plugin(SkillFilesystem, {
    // A unique provider name: the base bundle already registers a "filesystem"
    // provider in the same (global) layer, and duplicate names would throw.
    providerName: "explainer-video-from-coursework-dsh",
    includeDefaultRoots: false,
    customSkillDirs: [skillsDir],
  });
}
