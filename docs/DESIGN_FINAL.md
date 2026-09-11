# Design system — Etapa 3 (redesenho premium)

> Ver `docs/UX_AUDIT.md` para o estado anterior e `docs/FINAL_REVIEW.md`
> para o balanço final (o que foi feito vs. o que ficou de fora do escopo
> desta etapa, e por quê).

## Direção

Grafite/off-white premium, inspirado em princípios Apple (hierarquia,
espaço negativo, profundidade discreta), com azul institucional como cor de
identidade/estado principal — não preto absoluto, não decoração sem
significado. Cor semântica: azul = identidade/estado principal, verde =
positivo, vermelho = problema, amarelo = atenção, cinza = neutro.

## Tokens (`web/assets/style.css`)

Todos os nomes de variável originais foram preservados (`--bg-0`..`--bg-3`,
`--ink-0`..`--ink-3`, `--hairline`, `--r-lg/md/sm/pill`, `--shadow-*`) —
só os *valores* mudaram, de escuro para claro. Isso evita qualquer
regressão no JavaScript, que nunca lê essas variáveis diretamente (só um
lugar usa `var(--ink-3)` como cor inline, mantido).

- `--bg-0/1/2/3`: canvas off-white (`#f2f3f6`) → superfícies brancas/quase
  brancas, nunca preto.
- `--ink-0/1/2/3`: grafite (`#14161c`) com opacidade decrescente — nunca
  preto puro.
- `--accent` / `--accent-strong`: azul institucional (`#1a56db` /
  `#123f9e`) — CTA, estado ativo, links de destaque, prioridade.
- `--good` / `--warn` / `--critical`: verde/âmbar/vermelho com contraste
  adequado sobre fundo claro (ver seção Acessibilidade).
- `--wash` / `--wash-strong`: novo par de tokens para hover/estado sutil
  sobre fundo claro (substitui os antigos `rgba(255,255,255,.NN)` que só
  faziam sentido sobre fundo escuro — 47 ocorrências revisadas uma a uma).
- `--rail-w` / `--rail-w-collapsed`: largura da sidebar (expandida/colapsada).

## Componentes novos

### Sidebar (`app-rail`)
Navegação persistente por âncora (não são páginas separadas — a aplicação
continua sendo uma página única com seções, então a sidebar rola até a
seção e destaca o item ativo via `IntersectionObserver`, não roteamento).
Itens: Visão Geral, Cadastro, Desempenho, Clientes, Gestores, Auditoria —
todos mapeados a seções que **já existiam** (nenhuma página nova foi
inventada). Colapsa para ícone-apenas via botão no rodapé da sidebar.
Oculta abaixo de 980px (desktop é prioridade — ver `PERFORMANCE`/`ESCOPO`).

### Drawer de filtros (`filter-toolbar` + `drawer-overlay`/`drawer-panel`)
Substitui a "parede de chips" por: `[Filtros ▤]` com contador + resultado
da busca sempre visíveis, e um painel lateral (mesma animação dos modais
existentes: overlay + `is-open` + Escape + clique fora) contendo os grupos
de filtro. No Cadastro, os "filtros ativos" continuam visíveis como chips
removíveis fora do drawer (já existia, só ganhou nova casca visual).

**Decisão deliberada**: os filtros continuam aplicando *ao vivo* (como já
funcionavam), sem um botão "Aplicar" que exigisse acumular mudanças antes
de confirmar — introduzir um passo de "Aplicar" mudaria o comportamento
funcional já testado e certamente. O rodapé do drawer do Cadastro tem só
"Limpar filtros"; o do Dashboard nem isso, porque o botão "Limpar" já vive
na barra de resultado (mais visível fora do drawer).

### Menu de ações (`actions-menu`)
Substitui os 4 botões de texto por linha da tabela do Cadastro (Histórico,
Atendimentos, Editar, Excluir) por um único botão "⋯" com lista suspensa.
Delegação de evento global em `app.js` (`initActionsMenusGlobal`) — funciona
para qualquer linha recriada dinamicamente, fecha ao clicar fora ou Esc.

### Badges semânticos
`badge-status-*` (Concluinte/Participante/Sem atendimento/Inconsistente) e
o novo `badge-prioritario` (antes reaproveitava a cor verde de "sucesso",
semanticamente errado — agora usa azul, junto com o estado ativo/identidade,
não confundido com resultado positivo).

## O que foi conscientemente mantido sem alteração

Toda a lógica de dados, permissões, filtros, ordenação, paginação, RLS,
histórico/versionamento e auditoria — **zero mudança de comportamento**,
só apresentação. Nomes de ID e de função no JS não mudaram (só duas exceções
pontuais e seguras: `badge-insert` → `badge-prioritario` no marcador de
prioridade, e a estrutura interna da coluna de ações da tabela).
