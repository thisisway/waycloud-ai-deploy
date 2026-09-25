import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM served to the browser, without type declarations
import { checkForm, maskDoc, maskPhone, signup } from "../../apps/mcp-service/public/flow.js";

describe("input masks", () => {
  it.each([
    ["", ""],
    ["1", "(1"],
    ["11", "(11"],
    ["119", "(11) 9"],
    ["1199998888", "(11) 9999-8888"],
    ["11999998888", "(11) 99999-8888"],
    ["(11) 99999-8888 extra 77", "(11) 99999-8888"], // never more than 11 digits
    ["abc", ""],
  ])("phone %j -> %j", (raw, out) => expect(maskPhone(raw)).toBe(out));

  it.each([
    ["CPF", "52998224725", "529.982.247-25"],
    ["CPF", "529.982", "529.982"],
    ["CPF", "529.982.247-25999", "529.982.247-25"],
    ["CPF", "abc5299", "529.9"],
    ["CNPJ", "11222333000181", "11.222.333/0001-81"],
    ["CNPJ", "1a2b3c4d5e6f7g", "1A.2B3.C4D/5E6F-7G"], // the new alphanumeric CNPJ
    ["CNPJ", "11.222", "11.222"],
  ])("%s %j -> %j", (tipo, raw, out) => expect(maskDoc(tipo, raw)).toBe(out));
});

describe("quick form checks", () => {
  const ok = { nome: "Maria da Silva", email: "maria@example.com", doc_tipo: "CPF", doc_numero: "529.982.247-25", telefone: "(11) 99999-8888", aceite: true };
  it("accepts a complete form", () => expect(checkForm(ok)).toEqual({}));
  it("reports each problem on its own field", () => {
    expect(Object.keys(checkForm({ nome: "Maria", email: "x@y", doc_tipo: "CPF", doc_numero: "123", telefone: "12", aceite: false })).sort()).toEqual(["aceite", "doc_numero", "email", "nome", "telefone"]);
  });
  it("CNPJ needs 14 characters, CPF 11 digits, and a +55 phone is fine", () => {
    expect(checkForm({ ...ok, doc_tipo: "CNPJ", doc_numero: "11.222.333/0001-81" })).toEqual({});
    expect(checkForm({ ...ok, doc_tipo: "CPF", doc_numero: "1A222333000181" }).doc_numero).toBeTruthy();
    expect(checkForm({ ...ok, telefone: "+55 11 99999-8888" })).toEqual({});
  });
});

describe("signup()", () => {
  const api = (respond: () => Promise<Response>) => ({ base: "", fetch: respond });
  const json = (status: number, body: object) => async () => new Response(JSON.stringify(body), { status });

  it("success gives the redirect", async () => {
    expect(await signup(api(json(200, { ok: true, redirect: "https://app.test/pay" })), {})).toEqual({ ok: true, redirect: "https://app.test/pay" });
  });
  it("field errors and the fallback link are handed back", async () => {
    const r = await signup(api(json(422, { ok: false, errors: { email: "Já existe." }, fallback_url: "https://app.test/x" })), {});
    expect(r).toMatchObject({ ok: false, status: 422, errors: { email: "Já existe." }, fallbackUrl: "https://app.test/x" });
  });
  it("general failures carry the fixed message and the status", async () => {
    expect(await signup(api(json(429, { ok: false, mensagem_para_usuario: "Limite" })), {})).toMatchObject({ ok: false, status: 429, mensagem: "Limite" });
  });
  it("a network failure never throws", async () => {
    const r = await signup(api(async () => Promise.reject(new Error("offline"))), {});
    expect(r).toMatchObject({ ok: false, status: 0 });
    expect(r.mensagem).toMatch(/conexão/);
  });
  it("sends the JSON body to /web/checkout", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    await signup({ base: "http://x", fetch: async (url: string, init: RequestInit) => ((seen = { url, init }), new Response("{}", { status: 400 })) }, { a: 1 });
    expect(seen!.url).toBe("http://x/web/checkout");
    expect([seen!.init.method, seen!.init.body]).toEqual(["POST", '{"a":1}']);
  });
});
