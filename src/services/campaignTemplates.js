// Ready-made broadcast messages. The parts only the sender knows are written in [square brackets]; a broadcast
// can't be sent while one of these is still in the text. {{first_name}}, {{name}} and {{company}} are filled
// in for each person.
const STOP = " Reply STOP to unsubscribe.";

export const CAMPAIGN_TEMPLATES = [
  { id: "offer", name: "Special offer", description: "Tell customers about a deal.", text: `Hi {{first_name}}! 🎉 {{company}} has a special offer for you: [your offer]. Valid until [date]. Reply here to order.${STOP}` },
  { id: "new-arrivals", name: "New arrivals", description: "Show what is new.", text: `Hi {{first_name}}, new at {{company}}: [what's new]. See it here: [link].${STOP}` },
  { id: "back-in-stock", name: "Back in stock", description: "Tell people an item they wanted is back.", text: `Good news {{first_name}}! [product] is back in stock at {{company}}. Reply to reserve yours.${STOP}` },
  { id: "event", name: "Event invitation", description: "Invite people to an event.", text: `Hi {{first_name}}, you're invited to [event] on [date] at [place]. Reply YES to save your seat.${STOP}` },
  { id: "festival", name: "Festival greeting", description: "Send your wishes for a holiday.", text: `Warm wishes from all of us at {{company}}, {{first_name}}! May [festival] bring you joy and success. ✨${STOP}` },
  { id: "appointment", name: "Appointment reminder", description: "Remind people of a booking.", text: "Hi {{first_name}}, a reminder of your appointment with {{company}} on [date] at [time]. Reply to confirm or to reschedule." },
  { id: "feedback", name: "Ask for feedback", description: "Ask how it went.", text: "Hi {{first_name}}, thanks for choosing {{company}}! How was your experience? Reply with a number from 1 (poor) to 5 (excellent)." },
  { id: "payment", name: "Payment reminder", description: "A friendly nudge about a payment.", text: "Hi {{first_name}}, a friendly reminder that your payment of [amount] to {{company}} is due on [date]. Pay here: [link]. Reply if you need any help." },
  { id: "win-back", name: "We miss you", description: "Bring back customers who went quiet.", text: `Hi {{first_name}}, it's been a while! {{company}} would love to see you again. Here is [offer] just for you.${STOP}` },
  { id: "announcement", name: "Announcement", description: "Share news with everyone.", text: `Hi {{first_name}}, an update from {{company}}: [your news]. Reply with any questions.${STOP}` },
].map((t) => ({ ...t, blanks: t.text.match(/\[[^\]]+\]/g) || [] }));

// The fill-in-the-blank markers of every template: if one is still in a message, the sender forgot to write it.
export const unfilledBlanks = (text) => {
  const found = new Set();
  for (const t of CAMPAIGN_TEMPLATES) for (const blank of t.blanks) if (String(text).includes(blank)) found.add(blank);
  return [...found];
};
