// Ready-made workflows. They are the starting point when Riwo cannot write one (no provider is connected, or it did not give an
// answer that could be used), and the way to "start from an example". Each returns the same shape as a model's draft, so it is
// checked and shown exactly like one.

const TRIAGE = (o) => ({
  name: "Work or family and friends",
  trigger: { type: "returning", silentDays: 30, includeNew: true, keywords: [] },
  workflow: {
    start: "n1",
    nodes: {
      n1: { type: "branch", on: "label", label: "Family & friends", yes: "n2", no: "n4" },
      n2: { type: "say", text: "Hi {{first_name}}! I've let the boss know you wrote. He'll get back to you soon.", next: "n3" },
      n3: { type: "notify", who: "owners", text: "{{name}} (family or friend) wrote: {{last_message}}" },
      n4: {
        type: "ask",
        question: "Is this about work, or are you family or a friend?",
        saveAs: "relation",
        options: [
          { key: "work", label: "Work", hints: ["business", "project", "order", "quote", "काम"] },
          { key: "personal", label: "Family or friend", hints: ["family", "friend", "personal", "relative", "dost", "bhai"] },
        ],
        next: { work: "n5", personal: "n6" },
      },
      n5: { type: "agent", goal: "Find out what they need and arrange a meeting", playbook: "Professional and brief. Ask about their requirements, one question at a time. Never talk about prices.", closeWith: "book_demo", pricing: "handoff" },
      n6: { type: "say", text: "Lovely to hear from you! The boss has been told and will reply himself.", next: "n7" },
      n7: { type: "label", add: "Family & friends", next: "n3" },
    },
  },
  handoff: "I'm sorry, I can't help further. I'll connect you with a colleague right away.",
  formal: "Hi {{first_name}}, I'm {{executive}} and will take over to help you further.",
  followUpHours: 2,
  stageName: "",
  understood: `Anyone new, or back after a month, is asked whether it is about work. Work gets a professional conversation that ends in a meeting; family and friends get a warm note and ${o.owner || "you"} are told.`,
});

const AFTER_HOURS = () => ({
  name: "After-hours enquiries",
  trigger: { type: "after_hours", includeNew: true, keywords: [], hours: { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" } },
  workflow: {
    start: "n1",
    nodes: {
      n1: { type: "say", text: "Thanks for writing to {{company}}. We're closed right now and will reply as soon as we open.", next: "n2" },
      n2: { type: "collect", question: "What can we help you with?", saveAs: "need", next: "n3" },
      n3: { type: "task", title: "Reply to {{name}}: {{need}}", dueHours: 12, next: "n4" },
      n4: { type: "say", text: "Thank you, I've noted that. Someone will get back to you in the morning.", next: "n5" },
      n5: { type: "notify", who: "owners", channels: ["app"], text: "{{name}} wrote after hours: {{need}}" },
    },
  },
  handoff: "",
  formal: "",
  followUpHours: 2,
  stageName: "",
  understood: "When someone writes outside your opening hours, they are told you are closed and asked what they need. The team gets a follow-up for the morning.",
});

const WELCOME_BACK = () => ({
  name: "Welcome people back",
  trigger: { type: "returning", silentDays: 30, includeNew: false, keywords: [] },
  workflow: {
    start: "n1",
    nodes: {
      n1: { type: "say", text: "Welcome back, {{first_name}}! Good to hear from you.", next: "n2" },
      n2: {
        type: "ask",
        question: "Is this about something new, or about something we already did together?",
        saveAs: "topic",
        options: [
          { key: "new", label: "Something new", hints: ["new", "another", "fresh"] },
          { key: "existing", label: "Something we already did", hints: ["existing", "earlier", "previous", "update", "change"] },
        ],
        next: { new: "n3", existing: "n4" },
      },
      n3: { type: "agent", goal: "Find out what the returning customer needs now and arrange a call", playbook: "Warm and brief, they already know us. Ask what they need, one question at a time. Never talk about prices.", closeWith: "book_demo", pricing: "handoff" },
      n4: { type: "say", text: "Thanks! I've told the team and they will reply here shortly.", next: "n5" },
      n5: { type: "notify", who: "assignee", text: "{{name}} is back about something we did before: {{last_message}}" },
    },
  },
  handoff: "I'm sorry, I can't help further. I'll connect you with a colleague right away.",
  formal: "Hi {{first_name}}, I'm {{executive}} and will take over to help you further.",
  followUpHours: 2,
  stageName: "",
  understood: "Customers who come back after a quiet month are welcomed and asked whether it is something new or something from before. New needs get a conversation that ends in a call; old ones go straight to the team.",
});

export const RECIPES = [
  { id: "triage", title: "Work or family and friends", summary: "Asks whether it is about work. Work gets a professional conversation that ends in a meeting; family and friends get a warm note and you are told.", looksLike: /(work|business)[\s\S]*(family|friend|personal)|(family|friend|personal)[\s\S]*(work|business)/i, build: TRIAGE },
  { id: "after_hours", title: "After-hours enquiries", summary: "Tells people you are closed, asks what they need, and gives your team a follow-up for the morning.", looksLike: /(after[- ]hours|closed|night|outside (of )?(office|working|business) hours|holiday)/i, build: AFTER_HOURS },
  { id: "welcome_back", title: "Welcome people back", summary: "Greets customers who return after a quiet spell and sends new needs to a conversation, old ones to your team.", looksLike: /(returning|come back|comes back|came back|after a (month|while)|quiet|win[- ]?back|existing customers?)/i, build: WELCOME_BACK },
];
export const recipeList = () => RECIPES.map(({ id, title, summary }) => ({ id, title, summary }));
export const recipeById = (id) => RECIPES.find((r) => r.id === id) || null;
// the ready-made workflow that looks most like what the owner wrote, or null
export const recipeFor = (text) => RECIPES.find((r) => r.looksLike.test(String(text || ""))) || null;
