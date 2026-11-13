import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { apiErrorMessage } from "./errors";

describe("apiErrorMessage", () => {
  it.each([
    [400, "duration_min must be between 1 and 1440", "Revisá los datos ingresados."],
    [403, "not allowed", "No tenés permiso para hacer esto."],
    [404, "not found", "No se encontró lo que pedías."],
    [409, "conflict", "Ya existe un registro con esos datos."],
    [500, "boom", "Ocurrió un error en el servidor. Probá de nuevo más tarde."],
  ])("translates %i without leaking the server text", (status, text, expected) => {
    const message = apiErrorMessage(new ApiError(status, text), "fallback");
    expect(message).toBe(expected);
    expect(message).not.toContain(text);
  });

  it("uses the fallback for other errors", () => {
    expect(apiErrorMessage(new Error("x"), "fallback")).toBe("fallback");
    expect(apiErrorMessage(new ApiError(418, "teapot"), "fallback")).toBe("fallback");
  });
});
