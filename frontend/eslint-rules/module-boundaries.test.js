// @vitest-environment node
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "./module-boundaries.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

const SRC = "/repo/frontend/src";
const WIN_SRC = "C:\\repo\\frontend\\src";

tester.run("module-boundaries", rule, {
  valid: [
    // Inside one module, including its subfolders.
    { filename: `${SRC}/modules/campus/CampusPage.tsx`, code: 'import { x } from "./api";' },
    {
      filename: `${SRC}/modules/campus/shaping/ShapingPanel.tsx`,
      code: 'import { Preview } from "../components/Preview";',
    },
    {
      filename: `${SRC}/modules/campus/shaping/deep/Diff.tsx`,
      code: 'import { api } from "../../api";',
    },
    {
      filename: `${WIN_SRC}\\modules\\campus\\shaping\\ShapingPanel.tsx`,
      code: 'import { Preview } from "../components/Preview";',
    },
    // Another module through its index.
    { filename: `${SRC}/modules/grades/Gradebook.tsx`, code: 'import { x } from "../roster";' },
    {
      filename: `${SRC}/modules/campus/shaping/ShapingPanel.tsx`,
      code: 'import { x } from "../../classes/index";',
    },
    { filename: `${SRC}/app/routes.tsx`, code: 'import * as campus from "../modules/campus";' },
    // Shared code and packages.
    {
      filename: `${SRC}/modules/grades/Gradebook.tsx`,
      code: 'import { apiGet } from "../../shared/api";',
    },
    { filename: `${SRC}/modules/grades/Gradebook.tsx`, code: 'import { useState } from "react";' },
    { filename: `${SRC}/shared/ui/Button.tsx`, code: 'import "./ui.css";' },
  ],
  invalid: [
    // The old loophole: a sibling path without "modules/" in the string.
    {
      filename: `${SRC}/modules/grades/Gradebook.tsx`,
      code: 'import { getHealth } from "../health/api";',
      errors: [{ messageId: "deepImport" }],
    },
    {
      filename: `${SRC}/modules/campus/shaping/ShapingPanel.tsx`,
      code: 'import { x } from "../../roster/api";',
      errors: [{ messageId: "deepImport" }],
    },
    {
      filename: `${WIN_SRC}\\modules\\campus\\shaping\\ShapingPanel.tsx`,
      code: 'import { x } from "../../roster/api";',
      errors: [{ messageId: "deepImport" }],
    },
    {
      filename: `${SRC}/app/routes.tsx`,
      code: 'import { LoginPage } from "../modules/auth/LoginPage";',
      errors: [{ messageId: "deepImport" }],
    },
    {
      filename: `${SRC}/modules/grades/index.ts`,
      code: 'export { x } from "../slides/live/x";',
      errors: [{ messageId: "deepImport" }],
    },
    {
      filename: `${SRC}/modules/grades/Gradebook.tsx`,
      code: 'const m = import("../classes/ClassPage");',
      errors: [{ messageId: "deepImport" }],
    },
    {
      filename: `${SRC}/shared/api.ts`,
      code: 'import { x } from "../modules/auth";',
      errors: [{ messageId: "sharedImportsModule" }],
    },
  ],
});
