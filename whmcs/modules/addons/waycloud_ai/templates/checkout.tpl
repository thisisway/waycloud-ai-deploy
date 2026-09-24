{literal}
<style>
  .wc-wrap { max-width: 480px; margin: 0 auto; padding: 8px 4px 32px; }
  .wc-card { border: 1px solid #dfe3e8; border-radius: 10px; padding: 16px; margin-bottom: 16px; background: #fff; }
  .wc-plan { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .wc-plan strong { font-size: 1.15em; }
  .wc-price { font-size: 1.3em; font-weight: 700; white-space: nowrap; }
  .wc-field { margin-bottom: 14px; }
  .wc-field label { display: block; font-weight: 600; margin-bottom: 4px; }
  .wc-field input[type=text], .wc-field input[type=email], .wc-field input[type=tel], .wc-field input[type=password], .wc-field select {
    width: 100%; box-sizing: border-box; padding: 12px; font-size: 16px; border: 1px solid #b8c0cc; border-radius: 8px; }
  .wc-row { display: flex; gap: 8px; }
  .wc-row select { width: 110px; flex: none; }
  .wc-err { color: #b42318; font-size: .9em; margin-top: 4px; min-height: 1em; }
  .wc-hint { color: #5b6573; font-size: .85em; margin-top: 4px; }
  .wc-btn { width: 100%; padding: 14px; font-size: 17px; font-weight: 700; color: #fff; background: #0b6b3a; border: 0; border-radius: 8px; cursor: pointer; }
  .wc-btn:disabled { opacity: .6; cursor: wait; }
  .wc-alert { background: #fef3f2; border: 1px solid #fecdca; color: #7a271a; border-radius: 8px; padding: 12px; margin-bottom: 14px; }
  .wc-hp { position: absolute; left: -9999px; height: 0; overflow: hidden; }
  .wc-consent { display: flex; gap: 8px; align-items: flex-start; font-size: .92em; }
</style>
{/literal}

<div class="wc-wrap">
{if $wc_state eq 'invalid'}
  <div class="wc-card">
    <h3>Link inválido</h3>
    <p>Não encontramos esta contratação. Peça um novo link ao assistente que está ajudando você a publicar o site.</p>
  </div>
{elseif $wc_state eq 'expired'}
  <div class="wc-card">
    <h3>Este link expirou</h3>
    <p>Por segurança, o link de contratação tem validade limitada. Peça um novo link ao assistente que está ajudando você a publicar o site.</p>
  </div>
{elseif $wc_state eq 'used'}
  <div class="wc-card">
    <h3>Pedido já criado</h3>
    <p>Esta contratação já foi iniciada. Acesse sua <a href="clientarea.php?action=invoices">área do cliente</a> para ver a fatura e pagar com Pix ou cartão.</p>
  </div>
{else}
  <div class="wc-card">
    <div class="wc-plan">
      <div><strong>{$wc_plan|escape}</strong><br><span class="wc-hint">Cobrança {$wc_cycle|escape}</span></div>
      <div class="wc-price">{$wc_price|escape}</div>
    </div>
  </div>

  <form method="post" action="index.php?m=waycloud_ai" id="wc-form" novalidate>
    <input type="hidden" name="token" value="{$wc_csrf|escape}">
    <input type="hidden" name="t" value="{$wc_token|escape}">
    <div class="wc-hp"><label>Não preencha <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>

    {if $wc_errors._form}<div class="wc-alert">{$wc_errors._form|escape}</div>{/if}

    {if $wc_logged_in}
      <div class="wc-card"><p>Você já está conectado. O pedido será criado na sua conta.</p></div>
    {else}
      <div class="wc-field">
        <label for="wc-nome">Nome completo</label>
        <input type="text" id="wc-nome" name="nome" autocomplete="name" value="{$wc_old.nome|escape}" required>
        <div class="wc-err" data-for="nome">{$wc_errors.nome|escape}</div>
      </div>
      <div class="wc-field">
        <label for="wc-email">E-mail</label>
        <input type="email" id="wc-email" name="email" autocomplete="email" inputmode="email" value="{$wc_old.email|escape}" required>
        <div class="wc-err" data-for="email">{$wc_errors.email|escape}
          {if $wc_login_url} <a href="{$wc_login_url|escape}">Entrar na minha conta</a>{/if}</div>
      </div>
      <div class="wc-field">
        <label for="wc-doc">CPF ou CNPJ</label>
        <div class="wc-row">
          <select name="doc_tipo" id="wc-doctipo">
            <option value="CPF"{if $wc_old.doc_tipo ne 'CNPJ'} selected{/if}>CPF</option>
            <option value="CNPJ"{if $wc_old.doc_tipo eq 'CNPJ'} selected{/if}>CNPJ</option>
          </select>
          <input type="text" id="wc-doc" name="doc_numero" inputmode="text" autocomplete="off" value="{$wc_old.doc_numero|escape}" required>
        </div>
        <div class="wc-err" data-for="doc_numero">{$wc_errors.doc_numero|escape}</div>
      </div>
      <div class="wc-field">
        <label for="wc-tel">Telefone / WhatsApp</label>
        <input type="tel" id="wc-tel" name="telefone" autocomplete="tel" inputmode="tel" placeholder="(11) 99999-8888" value="{$wc_old.telefone|escape}" required>
        <div class="wc-err" data-for="telefone">{$wc_errors.telefone|escape}</div>
      </div>
      <div class="wc-field">
        <label for="wc-senha">Crie uma senha</label>
        <input type="password" id="wc-senha" name="senha" autocomplete="new-password" minlength="8" required>
        <div class="wc-hint">Mínimo de 8 caracteres.</div>
        <div class="wc-err" data-for="senha">{$wc_errors.senha|escape}</div>
      </div>
    {/if}

    <div class="wc-field">
      <label class="wc-consent">
        <input type="checkbox" name="aceite" value="1" required>
        <span>Li e aceito os <a href="{$wc_terms|escape}" target="_blank" rel="noopener">Termos de Serviço</a> e a
          <a href="{$wc_privacy|escape}" target="_blank" rel="noopener">Política de Privacidade</a>. Autorizo o uso dos meus dados para contratar e prestar o serviço.</span>
      </label>
      <div class="wc-err" data-for="aceite">{$wc_errors.aceite|escape}</div>
    </div>

    <button type="submit" class="wc-btn" id="wc-submit">Continuar para o pagamento</button>
    <p class="wc-hint" style="text-align:center">Você paga com Pix ou cartão na próxima tela. Seus dados não passam pelo assistente de IA.</p>
  </form>

{literal}
<script>
(function () {
  var form = document.getElementById('wc-form');
  if (!form) return;
  function digits(s) { return s.replace(/\D/g, ''); }
  function cpfOk(v) {
    var d = digits(v);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    for (var t = 9; t < 11; t++) {
      var s = 0;
      for (var i = 0; i < t; i++) s += +d[i] * (t + 1 - i);
      if (((s * 10) % 11) % 10 !== +d[t]) return false;
    }
    return true;
  }
  function cnpjOk(v) {
    var c = v.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
    function dv(base, w) {
      var s = 0;
      for (var i = 0; i < w.length; i++) s += (base.charCodeAt(i) - 48) * w[i];
      var r = s % 11;
      return r < 2 ? 0 : 11 - r;
    }
    var d1 = dv(c.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    var d2 = dv(c.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return d1 === +c[12] && d2 === +c[13];
  }
  function err(name, msg) {
    var el = form.querySelector('.wc-err[data-for="' + name + '"]');
    if (el && !el.querySelector('a')) el.textContent = msg;
  }
  var tipo = document.getElementById('wc-doctipo'), doc = document.getElementById('wc-doc');
  var tel = document.getElementById('wc-tel'), email = document.getElementById('wc-email');
  if (doc) doc.addEventListener('blur', function () {
    var ok = tipo.value === 'CPF' ? cpfOk(doc.value) : cnpjOk(doc.value);
    err('doc_numero', doc.value === '' || ok ? '' : (tipo.value === 'CPF' ? 'CPF inválido.' : 'CNPJ inválido.'));
  });
  if (email) email.addEventListener('blur', function () {
    err('email', email.value === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value) ? '' : 'Informe um e-mail válido.');
  });
  if (tel) tel.addEventListener('blur', function () {
    var n = digits(tel.value).replace(/^55(?=\d{10,11}$)/, '');
    err('telefone', tel.value === '' || n.length === 10 || n.length === 11 ? '' : 'Informe um telefone com DDD.');
  });
  form.addEventListener('submit', function () {
    var b = document.getElementById('wc-submit');
    b.disabled = true; // avoid double submits
    b.textContent = 'Aguarde...';
  });
})();
</script>
{/literal}
{/if}
</div>
