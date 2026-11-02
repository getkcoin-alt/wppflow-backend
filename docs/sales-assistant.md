# Sales assistant

An option of the "Let Riwo chat" rule (Automations → Sales assistant). It turns a new WhatsApp conversation into a qualified
lead and hands it to a person at the right moment.

## What happens

1. A customer writes for the first time. Riwo sends the company's welcome message together with the first question.
2. The customer answers. Riwo reads the chat and keeps each answer against the question it belongs to, answers a short factual
   question from the company's "about" text, and asks the next unanswered question **word for word** as the company wrote it.
3. After the first answer a **lead** is made automatically in the first step of the pipeline (the pipeline itself is created
   for a company that has none). It takes the number, and the teammate the chat is assigned to.
4. When the customer asks for **pricing, a quote or a proposal**, or when every question is answered, or Riwo reaches its reply
   limit, the chat is handed to an executive:
   - the customer gets the company's formal message (default: *"Thank you for your interest, {{first_name}}. Our executive
     {{executive}} has been assigned to review your requirements and will share the proposal and pricing with you shortly."*),
     with the usual "automated reply, say human" line;
   - the chat is marked as needing a person (`needs_human_since`, with `needs_human_reason` = `pricing`, `qualified`);
     Riwo and Autopilot stop answering it; the customer stays "waiting" on Today until a person replies;
   - the lead moves to the Proposal/Quote step for a pricing request (or the step the company chose; never backwards), or to
     Qualified when the questions are simply finished;
   - a private note in the chat lists what the customer said; the lead's history gets the same list;
   - the assigned teammate, the number's owner and the managers are notified ("X wants pricing");
   - a follow-up task is created for the teammate, due after the hours the company set (default 2, 0 for none), so the
     customer is not left waiting. It follows the usual reminder and 24-hour escalation.

## Setting it up from the company's website

In the form, "Your website" → **Read my website**. The server fetches the home page and up to three pages that tell about the
business (about, services, products, contact, FAQ), Riwo writes the "about" text (and 3–5 suggested questions) from them, and
the result lands in the form for the owner to read and edit. Nothing is saved until the rule is saved. The address is kept with
the rule (`config.website`).

- The address is typed by a customer, so it is treated as hostile: http(s) on ports 80/443 only, no credentials, never a private
  or reserved address (checked again on every redirect, and the connection is pinned to the checked address), 8 s and 1.5 MB per
  page, text pages only, at most 3 redirects, 6 requests a minute per person.
- The website text is data for the model, never instructions. Sentences that quote money, percentages or discounts are removed:
  pricing is for the executives. A line with the website address is added.
- Without a model (or if it fails) the page's own title, description and first lines are used, and no questions are suggested.

## Safety

- The pricing/proposal request is found by a word list (English, Arabic, Hindi, Hinglish) **before** the model is asked, and
  the model is told never to discuss prices. Riwo never states a price, discount, date or link that is not in the company's
  own text (the same check as every Riwo reply, also catching a lone "5%" or "AED 5").
- The formal message and the questions are the company's own words; the model never writes them.
- If the company has just asked about budget, an answer such as "around 5000" is kept as the answer; only a request ("send me
  the price list") hands over.
- Without a model (plan, switched off, allowance used, provider down) the questions and the pricing hand-off still work: each
  customer message is taken as the answer to the question just asked.
- Never runs in groups. A teammate's reply stops it for good, as for every Riwo chat.

## Data

Migration `045_sales_assistant`: `automation_chats.step`, `.requirements` (`[{ n, question, answer }]`), `.outcome`
(`pricing`, `qualified`, `limit`) and `conversations.needs_human_reason`.
