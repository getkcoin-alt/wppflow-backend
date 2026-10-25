// Ready-made automation rules. A person picks one, finishes the few details only they know (their prices,
// who takes complaints, their opening hours) and saves it paused. Keywords are in English, Arabic and Hindi
// where the words are common, and can be changed.
//
// `needs` lists what must be filled in before the rule can be saved: "reply" (the text to send), "teammate"
// (who gets the chat) and "hours" (when the company is open).
const keyword = (triggerCondition, match = "contains", extra = {}) => ({
  triggerType: "keyword",
  triggerCondition,
  config: { match, ...extra },
});

export const AUTOMATION_TEMPLATES = [
  // ── Start here ─────────────────────────────────────────────────────────────────────────────────
  {
    id: "welcome",
    group: "Start here",
    recommended: true,
    name: "Welcome new customers",
    description: "Greets someone the first time they message you.",
    rule: {
      triggerType: "first_message",
      actionType: "reply_text",
      actionSummary: "Hi {{first_name}}, thanks for contacting {{company}}! 👋 How can we help you today?",
      config: {},
    },
    needs: [],
  },
  {
    id: "after-hours",
    group: "Start here",
    recommended: true,
    name: "Away message after hours",
    description: "Tells customers who write outside your opening hours that you will reply when you are back. Sent once an evening, not for every message.",
    rule: {
      triggerType: "after_hours",
      actionType: "reply_text",
      actionSummary: "Thanks for your message! We're closed right now and will reply as soon as we're back.",
      config: { hours: { timezone: "Asia/Dubai", days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" }, cooldownHours: 12 },
    },
    needs: ["hours"],
  },
  {
    id: "stop",
    group: "Start here",
    recommended: true,
    name: "Unsubscribe when someone replies STOP",
    description: "Takes the customer off your broadcasts the moment they send STOP, and confirms. They can still chat with your team.",
    rule: {
      ...keyword("stop, unsubscribe, stop all, opt out, optout, إيقاف, ايقاف, إلغاء الاشتراك", "exact"),
      actionType: "opt_out",
      actionSummary: "",
      config: {
        match: "exact",
        reply: "You've been unsubscribed and won't get broadcast messages from {{company}}. You can still message us anytime. Reply SUBSCRIBE to join again.",
      },
    },
    needs: [],
  },
  {
    id: "subscribe",
    group: "Start here",
    recommended: true,
    name: "Subscribe when someone replies SUBSCRIBE",
    description: "Records the customer's permission for broadcasts when they ask for them, and confirms. The easiest way to build an opted-in list.",
    rule: {
      ...keyword("subscribe, join, sign me up, اشترك", "exact"),
      actionType: "opt_in",
      actionSummary: "",
      config: {
        match: "exact",
        reply: "You're subscribed! 🎉 You'll hear from {{company}} about offers and updates. Reply STOP anytime to unsubscribe.",
      },
    },
    needs: [],
  },
  // ── Answer common questions ────────────────────────────────────────────────────────────────────
  {
    id: "price",
    group: "Answer common questions",
    name: "Answer price questions",
    description: "Replies when someone asks what things cost.",
    hint: "Write your prices, or a link to your price list.",
    rule: {
      ...keyword("price, prices, pricing, cost, rate, rates, how much, سعر, أسعار, اسعار, بكم, कीमत, दाम"),
      actionType: "reply_text",
      actionSummary: "",
    },
    needs: ["reply"],
  },
  {
    id: "location",
    group: "Answer common questions",
    name: "Share your address",
    description: "Replies with where to find you when someone asks for your location.",
    hint: "Write your address and a map link.",
    rule: {
      ...keyword("location, address, where are you, directions, map, عنوان, موقع"),
      actionType: "reply_text",
      actionSummary: "",
    },
    needs: ["reply"],
  },
  {
    id: "opening-hours",
    group: "Answer common questions",
    name: "Answer opening-hours questions",
    description: "Replies when someone asks when you are open.",
    hint: "Write the days and times you are open.",
    rule: {
      ...keyword("opening hours, working hours, timings, are you open, what time do you open, closing time, ساعات العمل, مواعيد العمل"),
      actionType: "reply_text",
      actionSummary: "",
    },
    needs: ["reply"],
  },
  {
    id: "catalogue",
    group: "Answer common questions",
    name: "Send your catalogue or menu",
    description: "Replies when someone asks for a catalogue, menu or brochure.",
    hint: "Paste the link to your catalogue or menu.",
    rule: {
      ...keyword("catalog, catalogue, menu, brochure, products, كتالوج, منيو"),
      actionType: "reply_text",
      actionSummary: "",
    },
    needs: ["reply"],
  },
  {
    id: "booking",
    group: "Answer common questions",
    name: "Explain how to book",
    description: "Replies when someone wants an appointment or reservation.",
    hint: "Say how to book: a link, a phone number, or what you need to know.",
    rule: {
      ...keyword("book, booking, appointment, reservation, reserve, حجز, موعد"),
      actionType: "reply_text",
      actionSummary: "",
    },
    needs: ["reply"],
  },
  {
    id: "thanks",
    group: "Answer common questions",
    name: "Reply to thank-yous",
    description: "Answers a message that is only “thanks”. It never answers a longer message that happens to contain the word, and waits an hour between replies.",
    rule: {
      ...keyword("thanks, thank you, thx, thanku, shukran, شكرا, شكراً, धन्यवाद, shukriya, dhanyavad", "exact", { cooldownHours: 1 }),
      actionType: "reply_text",
      actionSummary: "You're welcome! 😊 Message us anytime if you need anything else.",
    },
    needs: [],
  },
  // ── Send to your team ──────────────────────────────────────────────────────────────────────────
  {
    id: "human",
    group: "Send to your team",
    name: "Hand over to a person",
    description: "When someone asks for a human, assigns the chat to a teammate and tells the customer someone is coming.",
    rule: {
      ...keyword("agent, human, representative, real person, talk to someone, speak to someone, customer service, موظف, خدمة العملاء", "contains"),
      actionType: "assign_agent",
      actionSummary: "",
      config: { match: "contains", reply: "Of course — I'm connecting you with our team. Someone will reply shortly." },
    },
    needs: ["teammate"],
  },
  {
    id: "complaint",
    group: "Send to your team",
    name: "Send complaints to a manager",
    description: "Assigns the chat to a manager when someone complains or asks for a refund, and tells the customer it has been escalated.",
    rule: {
      ...keyword("complaint, complain, refund, not working, disappointed, bad service, terrible, worst, شكوى"),
      actionType: "assign_agent",
      actionSummary: "",
      config: { match: "contains", reply: "We're sorry about that. A manager has been told and will contact you shortly." },
    },
    needs: ["teammate"],
  },
  {
    id: "order-status",
    group: "Send to your team",
    name: "Route order questions",
    description: "Assigns the chat to a teammate when someone asks about an order or delivery.",
    rule: {
      ...keyword("order status, my order, where is my order, delivery, tracking, shipment, track"),
      actionType: "assign_agent",
      actionSummary: "",
      config: { match: "contains", reply: "Thanks for asking! Our team is checking your order and will update you shortly." },
    },
    needs: ["teammate"],
  },
  // ── Organise leads ─────────────────────────────────────────────────────────────────────────────
  {
    id: "new-lead",
    group: "Organise leads",
    name: "Create a lead for every new customer",
    description: "Adds each new person who messages you to your sales pipeline, so nobody is forgotten. People who already have an open lead keep it.",
    rule: {
      triggerType: "first_message",
      triggerCondition: "",
      actionType: "create_lead",
      actionSummary: "",
      config: {},
    },
    needs: [],
  },
  {
    id: "quote-lead",
    group: "Organise leads",
    name: "Create a lead when someone asks for a quote",
    description: "Adds the person to your sales pipeline when they ask for a quote, a demo or more details, and thanks them.",
    rule: {
      ...keyword("quote, quotation, demo, interested, tell me more, more details, more info"),
      actionType: "create_lead",
      actionSummary: "",
      config: { match: "contains", reply: "Thanks for your interest! A member of our team will be in touch shortly." },
    },
    needs: [],
  },
  {
    id: "interested",
    group: "Organise leads",
    name: "Tag interested customers",
    description: "Adds an “interested” tag to people who ask for a demo, a quote or more details, so you can send them a broadcast later.",
    rule: {
      ...keyword("interested, demo, quote, quotation, tell me more, more details, more info"),
      actionType: "add_tag",
      actionSummary: "interested",
    },
    needs: [],
  },
];
