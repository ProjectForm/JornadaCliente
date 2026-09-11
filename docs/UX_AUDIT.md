# Auditoria visual — antes da Etapa 3 (redesign premium)

> **Metodologia**: este ambiente de execução não tem uma ferramenta de
> browser/screenshot disponível (sem Playwright, sem automação de UI). A
> auditoria abaixo foi feita lendo o código-fonte real (`web/index.html`,
> `web/assets/style.css`, `web/assets/app.js`, `web/assets/supabase-demo.js`)
> antes de qualquer alteração — não é uma inspeção visual de screenshots.
> Isso é dito explicitamente para não passar a falsa impressão de que houve
> revisão visual automatizada em navegador.

## Estado antes da Etapa 3

Tema escuro monocromático (`color-scheme: dark`), fundo quase preto
(`--bg-0: #08080a`), texto branco com opacidade decrescente para hierarquia
(`--ink-0`..`--ink-3`), acento neutro branco reservado para CTA. Sem cor de
marca — nem azul institucional, nem paleta semântica consistente para os
estados de negócio (verde/amarelo/vermelho existiam, mas eram usados de forma
pontual, não como sistema).

## Problemas identificados por tela/seção

### Header
- Nav com 4 links (Dashboard, Base, GitHub, CTA) competindo por atenção —
  spec pedia header "que ocupe pouco espaço" com ações globais discretas.
- Sem navegação persistente do tipo aplicativo (só scroll/âncora), o que
  obriga o usuário a rolar a página inteira para alternar entre Cadastro,
  Dashboard e Base.

### Home / Hero
- Boa hierarquia de texto (título → subtítulo → problema → prova de
  impacto), mas 100% em escala de cinza — nenhuma cor de identidade.
- `--fs-hero` chegava a `clamp(38px, 6vw, 72px)`, grande demais para uma
  ferramenta operacional (mais adequado a uma landing de marketing pura).

### Filtros (Dashboard e Cadastro)
- **Maior problema identificado.** Os filtros eram uma "parede de chips"
  sempre visível — Vertical, Status, Porte, Gestor (Dashboard) e ainda
  Município + toggles extras no Cadastro — ocupando uma faixa horizontal
  inteira antes mesmo dos dados aparecerem. Isso empurra o conteúdo
  principal para baixo e não escala bem com mais categorias.
- O Cadastro já tinha "filtros ativos" removíveis (`chip-removivel`) — um
  bom padrão, mas enterrado dentro da mesma parede de filtros.

### Tabela do Cadastro
- Coluna de ações com **4 botões de texto lado a lado** por linha
  (Histórico, Atendimentos, Editar, Excluir) — verboso, ocupa largura fixa,
  não escala se mais ações forem adicionadas.
- Badge de "Prioritário" reaproveitava a classe `badge-insert` (verde de
  sucesso) — semanticamente errado: prioridade é atenção/ação, não um
  resultado positivo.

### Estados
- Skeleton (loading) já existia para chips e KPIs — correto na essência,
  mas com paleta escura.
- Empty states existiam (texto + borda tracejada) mas sem ícone/ação
  consistente em todos os pontos (alguns eram só uma frase).
- Toasts, modais, drawer de detalhe do cliente: já seguiam um padrão de
  animação consistente (overlay + `is-open` + Escape + clique fora) — esse
  padrão foi **mantido e reaproveitado**, não uma vez descoberto durante a
  Etapa 2.

### "Aparência de sandbox"
- Nenhum vestígio de nomenclatura "sandbox/demo/mock" na UI (isso já tinha
  sido resolvido na Etapa 1 — ver `docs/PRODUTO.md` §1). O problema restante
  era puramente visual: tema genérico dark-mode sem identidade de marca, não
  terminologia.

## O que já estava bem resolvido (não mexer sem necessidade)

- Arquitetura de estado dos filtros (`dashState.filtros`, `cadastroFiltros`)
  já centralizada e reativa — só precisava de nova casca visual.
- Paginação, ordenação, exportação XLSX, histórico/versionamento,
  detecção de duplicidade: funcionalmente completos, só precisavam de
  restilo.
- Padrão de animação de overlay (modal/drawer/painel) já consistente e
  correto — reaproveitado para os novos drawers de filtro.

## Decisão

Redesenho completo do design system (tokens de cor/tipografia/sombra),
mantendo 100% dos nomes de classe/ID usados pelo JavaScript (evita
regressão funcional), com os componentes novos descritos em
`docs/DESIGN_FINAL.md`.
