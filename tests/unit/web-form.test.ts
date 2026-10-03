import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM served to the browser, without type declarations
import { checkForm, maskDoc, maskPhone, checkAddress, getPix, maskCep, signup, maskCardNumber, maskExpiry, luhnOk, checkCard, installmentOptions, tokenizeCard, chargeCard, getConfig, brl } from "../../apps/mcp-service/public/flow.js";

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

describe("getPix()", () => {
  const withBody = (status: number, body: object) => ({ base: "http://x", fetch: async () => new Response(JSON.stringify(body), { status }) });
  it("returns the Pix the service found", async () => {
    const pix = { ok: true, copia_cola: "000201", qr: "data:image/png;base64,AA==", valor_centavos: 3590 };
    expect(await getPix(withBody(200, pix), "s")).toEqual(pix);
  });
  it("is null when there is none, on errors and on network failures (the page then uses the invoice link)", async () => {
    expect(await getPix(withBody(200, { ok: false }), "s")).toBeNull();
    expect(await getPix(withBody(401, { ok: true, copia_cola: "x" }), "s")).toBeNull();
    expect(await getPix({ base: "http://x", fetch: async () => Promise.reject(new Error("offline")) }, "s")).toBeNull();
  });
});

describe("card payment", () => {
  describe("masks", () => {
    it.each([
      ["4111111111111111", "4111 1111 1111 1111"],
      ["4111 1111 1111 1111 9999", "4111 1111 1111 1111"], // never more than 16 digits
      ["abc", ""],
    ])("card number %j -> %j", (raw: string, out: string) => expect(maskCardNumber(raw)).toBe(out));
    it.each([
      ["1225", "12/25"],
      ["12/25", "12/25"],
      ["122599", "12/25"],
    ])("expiry %j -> %j", (raw: string, out: string) => expect(maskExpiry(raw)).toBe(out));
  });

  describe("luhnOk()", () => {
    it("accepts known-valid test card numbers and rejects a mistyped digit", () => {
      expect(luhnOk("4111 1111 1111 1111")).toBe(true);
      expect(luhnOk("4111 1111 1111 1112")).toBe(false);
      expect(luhnOk("123")).toBe(false);
    });
  });

  describe("checkCard()", () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 2);
    const yy = String(future.getFullYear()).slice(-2);
    const ok = { numero: "4111 1111 1111 1111", nome: "Maria Silva", validade: `01/${yy}`, cvv: "123" };
    it("accepts a complete, valid card", () => expect(checkCard(ok)).toEqual({}));
    it("flags each problem on its own field", () => {
      expect(Object.keys(checkCard({ numero: "1234", nome: "", validade: "13/20", cvv: "12" })).sort()).toEqual(["cvv", "nome", "numero", "validade"]);
    });
    it("rejects an expired card", () => {
      expect(checkCard({ ...ok, validade: "01/20" }).validade).toBeTruthy();
    });
  });

  describe("installmentOptions()", () => {
    it("splits without interest, stopping at the configured max", () => {
      const o = installmentOptions(10000, 3); // R$100
      expect(o.map((x: { months: number }) => x.months)).toEqual([1, 2, 3]);
      expect(o[1].label).toBe(`2x de ${brl(5000)} sem juros`);
    });
    it("stops before the installment drops below R$5,00", () => {
      const o = installmentOptions(1000, 12); // R$10: only 1x and 2x clear the R$5 floor
      expect(o.map((x: { months: number }) => x.months)).toEqual([1, 2]);
    });
  });

  describe("tokenizeCard()", () => {
    const card = { numero: "4111 1111 1111 1111", nome: "Maria Silva", validade: "01/30", cvv: "123" };
    it("sends the card to Iugu directly (not our server) and returns the token", async () => {
      let seen: { url: string; init: RequestInit } | undefined;
      const fetchFn = async (url: string, init: RequestInit) => ((seen = { url, init }), new Response(JSON.stringify({ id: "tok_abc" }), { status: 200 }));
      expect(await tokenizeCard("ACC123", card, fetchFn)).toEqual({ ok: true, token: "tok_abc" });
      expect(seen!.url).toBe("https://api.iugu.com/v1/payment_token");
      const body = JSON.parse(seen!.init.body as string);
      expect(body).toMatchObject({ account_id: "ACC123", method: "credit_card", data: { number: "4111111111111111", verification_value: "123", first_name: "Maria", last_name: "Silva", month: "01", year: "2030" } });
    });
    it("a decline or network failure never throws", async () => {
      expect(await tokenizeCard("ACC123", card, async () => new Response(JSON.stringify({ errors: "cartão inválido" }), { status: 422 }))).toMatchObject({ ok: false });
      expect(await tokenizeCard("ACC123", card, async () => Promise.reject(new Error("offline")))).toMatchObject({ ok: false });
    });
  });

  describe("chargeCard()", () => {
    const withBody = (status: number, body: object) => ({ base: "http://x", fetch: async () => new Response(JSON.stringify(body), { status }) });
    it("relays the addon's result", async () => {
      expect(await chargeCard(withBody(200, { ok: true, message: null }), "s", "tok_abc", 2)).toEqual({ ok: true, message: null });
      expect(await chargeCard(withBody(200, { ok: false, message: "Cartão recusado." }), "s", "tok_abc", 1)).toEqual({ ok: false, message: "Cartão recusado." });
    });
    it("a network failure or bad response never throws", async () => {
      expect(await chargeCard({ base: "http://x", fetch: async () => Promise.reject(new Error("offline")) }, "s", "tok", 1)).toMatchObject({ ok: false });
    });
  });

  describe("getConfig()", () => {
    it("reads the public Iugu account id", async () => {
      const api = { base: "http://x", fetch: async () => new Response(JSON.stringify({ iugu_account_id: "ACC123" }), { status: 200 }) };
      expect(await getConfig(api)).toEqual({ iuguAccountId: "ACC123" });
    });
    it("is null when unset or on failure", async () => {
      expect(await getConfig({ base: "http://x", fetch: async () => new Response(JSON.stringify({ iugu_account_id: null }), { status: 200 }) })).toEqual({ iuguAccountId: null });
      expect(await getConfig({ base: "http://x", fetch: async () => Promise.reject(new Error("offline")) })).toEqual({ iuguAccountId: null });
    });
  });
});

describe("address for a domain purchase", () => {
  it("masks the CEP while typing", () => {
    expect([maskCep("01310"), maskCep("013101"), maskCep("01310-100 extra"), maskCep("abc")]).toEqual(["01310", "01310-1", "01310-100", ""]);
  });
  it("flags what is missing, and passes a complete address", () => {
    const ok = { cep: "01310-100", logradouro: "Avenida Paulista", numero: "1000", complemento: "", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP" };
    expect(checkAddress(ok)).toEqual({});
    expect(Object.keys(checkAddress({ ...ok, cep: "123", logradouro: "", numero: " ", bairro: "", cidade: "", uf: "" })).sort()).toEqual(["bairro", "cep", "cidade", "logradouro", "numero", "uf"]);
  });
});
