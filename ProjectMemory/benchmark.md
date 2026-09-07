# Benchmark — cdp-sniffer

Pra testar uma IA (jr ou jumenta) usando o sniffer, rola um ladder de 3 tasks
no https://the-internet.herokuapp.com. Cada task mede 1 skill do sniffer.
Critério: PASS = a IA devolve a resposta correta + é comprovada pela DB
(pode validar com a query do "como validar" depois).

## Task 1 — Qual endpoint o formulário acerta?

**Prompt pra IA:**
> Percebe. Abra https://the-internet.herokuapp.com/login no Chrome via
> `sniffer_start_stack { profile: "andreictg338@gmail.com" }`, insira
> `tomsmith/SuperSecretPassword!` nos campos e clique em Login. Me diz:
> qual é o endpoint exato, método, status e o que é retornado?

**Correto:** `POST /authenticate` → 302 → redirect pra `/secure` → 200.
Body: `username=tomsmith&password=SuperSecretPassword%21`. Cookie de sessão
`rack.session` novo no response.

**Como validar depois (você):**
```bash
sniffer query-http --method POST --url authenticate --last 1
sniffer get-http <request_id-retornado-acima>
```

**Mede:** descoberta de `sniffer_query_http` + `sniffer_get_http` com redirect chain.

---

## Task 2 — O que o clique fez (UI)?

**Prompt pra IA:**
> Clica em https://the-internent… não, espera, abra
> https://the-internet.herokuapp.com/add_remove_elements/, clica em
> "Add Element" 3 vezes, depois deleta 2. Me diz exatamente quais
> elementos foram adicionados/removidos — timestamp, tag, selector, texto.

**Correto:** 3 events `dom-add` do `<button class="added-manually">Delete</button>`,
depois 2 events `dom-remove`. Sobra 1 botão visível.

**Como validar:**
```bash
sniffer ui --ui-type dom-add --last 5
sniffer ui --ui-type dom-remove --last 5
```

**Mede:** se a IA acha que click = HTTP (comum em IA nova) ou sabe ir no `query_ui`.

---

## Task 3 — Race com mark & time window

**Prompt pra IA:**
> Numa janela de 10s, abre https://the-internet.herokuapp.com/dynamic_loading/2,
> clica "Start", espera "Hello World!" aparecer. Quero la Axios de novo:
> os events entre a marca `pre-click` e 5s depois, em ordem.

**Correto:** o flow é um GET assíncrono ou dom aparte do initial load
(como o aquivo demosntra) mas mais precisamente: a marca + `query_http(after_mark=...)`
não NÃO deve conter o GET de 404 loading.gif. Verifica via timestamp.

**Como validar:**
```bash
sniffer marks --last 2
sniffer query-http --after-mark pre-click --last 10
```

**Mede:** uso de marks corretamente + compreensão de timeline.

---

## Rubric (0-10)

| Criteria | Ptos |
|---|---|
| Usa `sniffer_get_status` antes de qlqr query | 1 |
| Usa marks (`sniffer_add_mark`) antes das ações | 2 |
| Prefere `query_http` sobre `query_events` pra HTTP | 2 |
| Usa `request_id` entre `query_http` → `get_http` | 2 |
| Responde com URLs exatas + status (não genérico) | 2 |
| Identifica `browsermcp` desconectado no Profile 1 sem travar | 1 |
