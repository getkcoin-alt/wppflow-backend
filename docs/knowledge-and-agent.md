# Knowledge base, the Riwo sales agent, and describing it in your own words

## The knowledge base (Automations → Knowledge base)

The owner gives Riwo up to five websites. Riwo reads each one page by page (up to 30 pages, the home page first, then the pages it links
to and what `sitemap.xml` lists, preferring product, service, portfolio, pricing, about and FAQ pages), then writes a short **profile**:
what the company is and every product or service it found, each with the page that describes it. The owner can add **notes** in their
own words (hours, how demos work, what the company never does).

- **Refresh** reads the site again and updates only what changed (a hash per page). A page taken down is removed, so Riwo never quotes
  what is no longer on the website. If nothing changed, Riwo is not asked to rewrite the profile. A site is also read again by itself
  every 24 hours, in the background, without holding up other jobs.
- Politeness and safety: `robots.txt` is obeyed, one page at a time with a pause, an address that is not a public website is refused
  when it is added, and the website text is data for Riwo, never instructions.
- Without Riwo (plan, switched off, allowance used) the profile is the home page's own words and the page titles as the product list.

**What Riwo is given for a customer** (`knowledgeFor`): the profile, the notes, and the pages that best match what the customer wrote
(words, lightly stemmed: a page is shown if its title has a word of theirs, or its text has two different ones), capped at about 4,000
characters. There is no vector database; a company with many products gets the product pages that match the question.

Every answer is checked against exactly that text: a price, figure, link or address that is not in it is never sent.

## The Riwo sales agent (Automations → Riwo sales agent)

An `ai_chat` rule with `config.agent = { goal, playbook, closeWith, pricing }`. Riwo answers every new customer, starting with the very
first message, from the knowledge base. It finds out what they need, recommends the product that fits, deals with doubts using what is
true, and works toward one close:

| `closeWith` | What Riwo does |
|---|---|
| `handoff` | Hands over when the customer is ready, asks for prices or asks for a person |
| `collect_details` | Gets their name and contact, then hands over |
| `book_demo` | Suggests a call or demo, gets a time, then hands over |
| `send_link` | Shares the right link from the knowledge base (copied exactly), then hands over on a yes |

What it learns about the customer (need, product of interest, team size, name, timeline…) is kept as labelled facts and shown to the
team in a private note and the lead's history. A lead is opened after the first facts.

Guard rails, all enforced by the server and not by the model:
- **Prices.** By default a request for prices, a quote or a proposal (English, Arabic, Hindi, Hinglish) is handed to a person with the
  company's formal message *before the model is asked*. A company may set `pricing: "knowledge"` to let Riwo repeat prices that are on
  its website; a price that is not on the website is never sent. Riwo never negotiates or promises a discount.
- A reply with a figure or link the company never wrote is rewritten once; if the second try fails too, the customer gets the company's
  holding message, once, and the team is told.
- A customer who asked for a person, an angry customer, something not in the knowledge base, a group chat, the reply limit (default 12,
  at most 20) or Riwo being unavailable: a person takes over, never an improvised answer.
- Everything Riwo sends says it is automated, is written to the automated-message record (trigger, rule, model, exact words), and a
  teammate's reply stops it for good.

## Describing it in your own words (`POST /api/automations/draft`)

The owner writes what Riwo should do, as they would brief a salesperson. Riwo either asks up to three short questions or drafts the
agent (name, goal, tone and instructions, close, price handling, the formal hand-over message, follow-up time, pipeline step). The draft
passes the same checks as a rule made by hand and comes back for the owner to read and edit; nothing is saved or switched on. It can only
draft what the product can do: an agent that starts on a first message (or a number from another country).

## Limits to state plainly

Riwo is as good as the website and notes it is given and the free or paid model behind it; it can still be clumsy. It does not learn from
chats. "Closing" means moving the customer to the next step the owner chose: it never invents terms, and a person finishes the sale.
Sites that only show their words after loading scripts cannot be read (the notes are the answer). Not tested against a real customer
conversation, a real provider or a real website yet.
