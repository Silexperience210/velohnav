// Questions et configurations du banc « conversation libre ».
// Questions : françaises, toutes hors du champ de l'assistant déterministe
// (answerLocally rend `unknown`) — ce sont celles qui atteignent le modèle.
export const QUESTIONS = [
  "Bonjour, comment ça va ?",
  "Qui es-tu ?",
  "Que peux-tu faire pour moi ?",
  "Merci beaucoup pour ton aide !",
  "Raconte-moi une blague sur le vélo.",
  "Comment fonctionne le Vel'OH! ?",
  "Faut-il un casque pour circuler en ville ?",
  "Comment bien régler la selle ?",
  "J'ai crevé un pneu, tu peux m'aider ?",
  "Quelle est la capitale du Luxembourg ?",
];

export const CONFIGS = [
  { id: "glouton", label: "glouton, sans pénalité", options: { do_sample: false } },
  { id: "glouton+rp", label: "glouton, repetition_penalty 1.05", options: { do_sample: false, repetition_penalty: 1.05 } },
  { id: "liquid", label: "carte Liquid : T 0.1, top_k 50, rp 1.05", options: { do_sample: true, temperature: 0.1, top_k: 50, repetition_penalty: 1.05 } },
  { id: "T0.7", label: "T 0.7, top_p 0.9 (température haute)", options: { do_sample: true, temperature: 0.7, top_p: 0.9 } },
];

// Conversation réelle rapportée sur téléphone (repro-conversation.mjs) : plusieurs tours
// libres enchaînés, dont la présentation « Je suis Silex ».
export const CONVERSATION = [
  "Bonjour",
  "Je suis Silex",
  "Tu te souviens de mon prénom ?",
  "Qui es-tu ?",
  "Merci beaucoup pour ton aide !",
  "Raconte-moi une blague sur le vélo.",
];
