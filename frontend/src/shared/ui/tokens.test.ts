import { describe, expect, it } from "vitest";
import prototype from "../../../../prototipo/campus.html?raw";

// The CSS pipeline is stubbed in tests, so the stylesheet is read from disk. `npm test` runs in frontend/.
const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync(path: string, encoding: string): string;
};
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const tokens = fs.readFileSync(`${cwd}/src/shared/ui/tokens.css`, "utf8").toLowerCase();

function proto(name: string): string {
  const match = new RegExp(`--${name}:(#[0-9a-fA-F]{6})`).exec(prototype);
  if (!match) throw new Error(`missing ${name} in prototype`);
  return match[1].toLowerCase();
}

describe("design tokens follow the Campus IA prototype", () => {
  it.each([
    ["azul", "--color-primary"],
    ["azul2", "--color-focus"],
    ["azulsuave", "--color-primary-soft"],
    ["tinta", "--color-text"],
    ["gris", "--color-text-muted"],
    ["linea", "--color-border"],
    ["fondo", "--color-bg"],
    ["verde", "--color-success"],
    ["verdesuave", "--color-success-soft"],
    ["ambarsuave", "--color-warning-soft"],
    ["rojo", "--color-danger"],
  ])("%s is %s", (name, token) => {
    expect(tokens).toContain(`${token}: ${proto(name)}`);
  });

  it("uses Inter as the first font", () => {
    expect(tokens).toMatch(/--font-sans:\s*inter,/);
  });

  it("uses the 56px bar", () => {
    expect(tokens).toContain("--bar-height: 3.5rem");
  });
});
