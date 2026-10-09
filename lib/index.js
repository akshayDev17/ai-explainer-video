import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Deliberately not declared in package.json: only DSH ever loads this module, and
// the harness's `healProfilesModuleFallback` puts its own dependency closure on
// Node's parent-walk from the profile directory. Declaring it here would put a
// DeepSeek dependency into the manifest that Claude Code and Codex install.
import {
  apply as skillFilesystemApply,
  Config as skillFilesystemConfig,
  inject as skillFilesystemInject,
  name as skillFilesystemName,
} from "@deepseek-ai/dsh-skill-filesystem";

export const name = "explainer-video-from-coursework";
export const inject = ["skills"];

const SkillFilesystem = {
  name: skillFilesystemName,
  inject: skillFilesystemInject,
  Config: skillFilesystemConfig,
  apply: skillFilesystemApply,
};

export function apply(ctx) {
  // This module lives in <pkg>/lib; the nine skill folders live in <pkg>/skills,
  // so one copy of the skills serves every platform that installs this package.
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
  ctx.plugin(SkillFilesystem, {
    // A unique provider name: the base bundle already registers a "filesystem"
    // provider in the same (global) layer, and duplicate names would throw.
    providerName: "explainer-video-from-coursework",
    includeDefaultRoots: false,
    customSkillDirs: [skillsDir],
  });
}
