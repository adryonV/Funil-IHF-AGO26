# Funil de Tráfego — IHF-AGO26 (Meta Ads + Google Ads)

Dashboard de funil de tráfego que cruza **2 planilhas Google** (métricas de anúncios + lista de leads),
monta o funil completo **Investimento → Impressões → Cliques → Page Views → Leads** e atribui os
leads à campanha / conjunto (ou grupo) / anúncio pelas UTMs. Roda **100% na nuvem**.

## Arquitetura

- **`build.mjs`** (Node 20, sem dependências): lê as planilhas via *export CSV* (somente leitura),
  cruza leads × anúncios por UTM e grava **`public/data.json`** agregado (sem dados pessoais).
- **`public/index.html`**: dashboard estático (Chart.js via CDN), com 4 abas:
  **Meta Ads**, **Google Ads**, **Pago + Orgânico** e **Insights**. Faz `fetch('data.json?v=<ts>')`
  com cache-bust.
- **GitHub Actions** (`.github/workflows/build.yml`): roda o build e publica no **GitHub Pages**
  a cada 2h (`schedule`), no `push`, no botão manual (`workflow_dispatch`) e via
  `repository_dispatch` (evento `rebuild`, usado pelo cron-job.org).

## Fontes (somente leitura)

| Planilha | ID | Aba(s) |
|---|---|---|
| Métricas dos Anúncios | `1lw-5M6W5HwvTrohtWm80SnUrzjlh5SNva0xW8BcGESU` | Meta Ads (gid 0) · Google Ads (gid 1326864235) |
| Lista de Leads | `12bpXRkwC3yknrPt2_AmDWnvoyT0f78FSpJhMZ5BLWbg` | Página1 (gid 0) |

## Regras de negócio

- **Imposto** `TAX_RATE = 1.1385` aplicado ao gasto **antes** de todas as métricas de custo (CPM, CPC, CPL…).
- **Atribuição por UTM**: `utm_campaign → Campaign Name`, `utm_medium → Ad Set/Group Name`, `utm_content → Ad Name`.
  UTMs são URL-decodificadas e normalizadas (whitespace) para casar com as planilhas.
- **Origem do lead**: `utm_source = Facebook-Ads → Meta` · `google-ads → Google` · demais → Orgânico.
- Placeholders não resolvidos (`{{campaign.name}}`) contam como lead pago **não atribuído**.

## Trigger externo (cron-job.org)

```
POST https://api.github.com/repos/adryonV/Funil-IHF-AGO26/dispatches
Headers: Accept: application/vnd.github+json | Authorization: Bearer <PAT> | User-Agent: cron-job
Body:    {"event_type":"rebuild"}
```
