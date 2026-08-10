# Material de divulgação — nplusone

Rascunhos prontos, plataforma por plataforma. Não é para publicar tudo de uma vez:
a ordem sugerida está no fim.

Duas regras que valem para todos:

1. **Nada de afirmação que não aconteceu.** Tudo abaixo é verificável — os bugs
   foram encontrados de verdade, os números foram medidos.
2. **Nenhum projeto do trabalho é nomeado.** "um monorepo NestJS", "uma aplicação
   Next.js" — nunca o nome da empresa ou do produto.

---

## 1. Show HN (o de maior retorno, e o mais arriscado)

**Título** (o HN corta em ~80 caracteres; este tem 74):

```
Show HN: Nplusone – catch N+1 queries in Node.js, with the line that caused them
```

**Primeiro comentário** (postar imediatamente após submeter; é onde a conversa acontece):

> Ruby has bullet and Python has nplusone; Node never got an equivalent, so I wrote one.
>
> It instruments the database driver rather than the ORM, which means one adapter covers Drizzle, Knex, TypeORM, MikroORM, Sequelize and raw SQL at once. Queries are counted inside a scope (a request, a job, a test), and when one statement shape repeats from one line of code with different values, it reports that line.
>
> Two things I got wrong at first and had to fix, which might be the interesting part:
>
> **Lazy ORMs destroy the stack trace.** With Drizzle, `await db.select()...` is executed by the runtime calling `.then()`, not by your code. I measured twelve frames at that point and not one belonged to the application — so the query was detected but attributed to nothing. The fix was to capture the call site during the synchronous query-building phase and republish it through AsyncLocalStorage while the query runs. The SQL still comes from the driver; the line comes from the ORM.
>
> **Bundlers duplicate modules.** Under Next.js, each route handler gets its own bundle, and a route ended up with a second copy of the library: the copy that patched the driver held one AsyncLocalStorage and the copy that opened the request scope held another. The scope opened, the queries ran, and the detector reported zero — with no error at all. Shared state now lives in a process-wide registry keyed with Symbol.for.
>
> I only found both by running it against real applications rather than fixtures. A third one came from the same exercise: transaction control (BEGIN/COMMIT) was being reported as duplicated work, and on a real login endpoint those were the only two findings, burying anything real.
>
> Zero runtime dependencies, and it disables itself when NODE_ENV=production.

**Quando postar:** terça a quinta, entre 8h e 10h da manhã no horário do leste dos EUA
(9h–11h em Brasília). Nunca sexta ou fim de semana.

**Depois de postar:** fique disponível por 2–3 horas para responder. No HN, responder
bem às críticas rende mais que o post em si. Se alguém disser "isso é só um APM pobre",
a resposta honesta é: um APM te diz que a página está lenta; isso te diz qual linha
disparou 50 queries, e falha o CI na próxima vez.

---

## 2. Reddit — r/node

**Título:**

```
I built the N+1 query detector Node was missing (Ruby has bullet, Python has nplusone)
```

**Corpo:**

> Every ORM tutorial warns about N+1 queries, and every codebase has them anyway — they are invisible in dev against a seeded database with three rows.
>
> Ruby has bullet, Python has nplusone. Node had query logs and squinting. So:
>
> ```
> nplusone 1 finding in GET /orders — 51 queries, 840ms
>
>   N+1 query  50× SELECT * FROM items WHERE order_id = ?
>      at src/routes/orders.ts:47:38  (loadOrdersPage)
>      612ms spent here
> ```
>
> It hooks the **driver**, not the ORM, so Drizzle, Knex, TypeORM, MikroORM, Sequelize and raw SQL are all covered by the same adapter. Prisma and Drizzle get extra adapters for reasons I explain in the README (Prisma does not use Node drivers at all; Drizzle is lazy and loses the stack trace).
>
> The part I actually care about is the test helper:
>
> ```ts
> await expectNoNPlusOne(() => loadOrdersPage(userId));
> ```
>
> A detector you have to remember to look at decays. An assertion in CI does not.
>
> Zero dependencies, MIT, off in production by default. Feedback welcome — especially if it misses something in your stack.

**Regra do r/node:** leia as regras de autopromoção antes. Participe de outras threads
por alguns dias antes de postar o seu; conta nova que só posta o próprio projeto é
removida.

---

## 3. JavaScript Weekly / Node Weekly

Submissão gratuita em https://cooperpress.com/publications (link "suggest a link").
São ~130 mil leitores e eles gostam de ferramenta nova com README bom.

**O que enviar** (eles reescrevem, então mande curto e factual):

> nplusone — Runtime N+1 query detection for Node.js, in the spirit of Ruby's bullet.
> Instruments the database driver rather than the ORM, so Drizzle, Knex, TypeORM and
> raw SQL are covered by one adapter. Reports the file and line that issued the
> repeated query, and ships a test helper that turns a finding into a CI failure.
> Zero dependencies.
>
> https://github.com/Truta446/nplusone

Envie **depois** que o Show HN acontecer — se o post for bem, mencione na submissão.

---

## 4. Dev.to — o artigo técnico (o que rende a longo prazo)

Este é o mais valioso dos cinco, porque ranqueia no Google e continua trazendo gente
meses depois. O assunto **não** é a lib; é o problema técnico.

**Título:**

```
Why your ORM's stack trace is empty (and how I got the line number back)
```

**Estrutura:**

1. **O sintoma.** Você instrumenta o driver, detecta a query repetida, e o call site
   vem vazio. Mostre a saída com `<unknown call site>`.
2. **A medição.** Não teorize — mostre o dump da pilha: doze frames, todos em
   `node_modules`. Cole o código que produziu esse dump para o leitor reproduzir.
3. **Por que acontece.** `await db.select()...` invoca `.then()` a partir do runtime.
   O frame de quem construiu a query já saiu. Contraste com TypeORM, onde `repo.find()`
   é uma função async que *você* chama e o Node preserva a cadeia — o mesmo problema
   não existe lá, e explicar essa diferença é o coração do artigo.
4. **A solução.** Capturar na fase síncrona de construção e republicar via
   AsyncLocalStorage. Mostre o código.
5. **O resultado.** Antes/depois, com a linha aparecendo.
6. Menção à lib no fim, em uma frase.

Publique também no Hashnode e no seu LinkedIn (ver abaixo) com link canônico para o
Dev.to, para não competir consigo mesmo no SEO.

---

## 5. LinkedIn

Só depois que o artigo do Dev.to existir. O post é a isca, o artigo é o destino.

> Passei a semana construindo uma ferramenta que o Node não tinha: um detector de
> N+1 queries em tempo de execução. Ruby tem o bullet há mais de dez anos, Python tem
> o nplusone. Node tinha log de query e paciência.
>
> A parte interessante não foi detectar — foi dizer QUAL LINHA do seu código causou.
>
> Com ORMs lazy como o Drizzle isso não funciona do jeito óbvio. Quando a query chega
> no driver, a pilha tem doze frames e nenhum é do seu código: quem disparou a execução
> foi o `await` do runtime, não você. Medi, não supus.
>
> A solução foi capturar a linha na fase síncrona de construção da query e transportá-la
> até a execução via AsyncLocalStorage.
>
> Rodando contra aplicações reais, encontrei três bugs que teste unitário nenhum pegaria
> — incluindo um em que a ferramenta falhava silenciosamente em qualquer projeto Next.js,
> porque o bundler duplica módulos e o escopo e o driver acabavam em instâncias
> diferentes de AsyncLocalStorage.
>
> Escrevi sobre o problema do stack trace aqui: [link do Dev.to]
> A lib é MIT e está aqui: github.com/Truta446/nplusone

**Não** poste "minha lib me ajudou no projeto X" — a ferramenta não encontrou nenhum
N+1 real nos projetos onde foi instalada até agora. O que ela encontrou foram bugs
**nela mesma**, e essa história é mais honesta e mais interessante.

---

## 6. Onde mais vale um empurrão barato

- **awesome-nodejs** — PR na seção de debugging/performance. Descoberta passiva, custo zero.
- **Discord do Drizzle e do TypeORM** — canal de "showcase". É gente com exatamente esse
  problema hoje. Não faça spam: poste uma vez, no canal certo.
- **Bluesky / X** — thread curta com o print do output. O banner do repo serve de imagem.

---

## Ordem sugerida

1. Escreva o artigo do Dev.to **primeiro** (é o ativo de longo prazo, e escrever
   clarifica o que dizer nos outros).
2. Show HN numa terça de manhã. Fique disponível para responder.
3. r/node no dia seguinte.
4. JavaScript Weekly / Node Weekly na mesma semana.
5. LinkedIn por último, apontando para o artigo.
6. awesome-nodejs e Discords quando o resto assentar.

Não faça tudo no mesmo dia: se o HN não pegar, você queima os outros canais junto.
