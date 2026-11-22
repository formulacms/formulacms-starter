import type { SampleField, SampleValues } from "./sim-sample-state"

export const SAMPLE_PRESETS = [
  { key: "default", label: "Short" },
  { key: "stress", label: "Long" },
  { key: "french", label: "French" },
] as const
export type SamplePreset = (typeof SAMPLE_PRESETS)[number]["key"]
type Copy = readonly [short: string, long: string, french: string]
const COPY: Record<string, Record<string, Copy>> = {
  "hero-agency": {
    "primary.eyebrow": [
      "Independent digital studio",
      "An independent digital studio in Montréal, working everywhere",
      "Un studio numérique indépendant",
    ],
    "primary.title": [
      "Good ideas deserve a great website",
      "We turn ambitious ideas into websites people remember and enjoy using",
      "Vos bonnes idées méritent un site remarquable",
    ],
    "primary.description": [
      "We build clear, useful digital experiences for growing teams.",
      "From the first conversation to the final detail, our designers and developers work together to make your next chapter clearer, faster and easier to share.",
      "Nous créons des expériences numériques utiles pour accompagner les équipes qui innovent.",
    ],
    "items.0.label": [
      "Meet the studio",
      "Discover the people behind our studio",
      "Découvrez notre équipe",
    ],
    "items.1.label": [
      "See our work",
      "Explore our latest selected projects",
      "Explorez nos réalisations",
    ],
  },
  "hero-with-image": {
    "primary.eyebrow": [
      "Made for your next chapter",
      "Thoughtful tools for your team's next ambitious chapter",
      "Pour votre prochain chapitre",
    ],
    "primary.eyebrowLinkLabel": [
      "Meet our team",
      "Get to know the people building with you",
      "Découvrez notre équipe",
    ],
    "primary.title": [
      "Make room for better work",
      "Give your team the space, clarity and confidence to do their best work together",
      "Faites place à un travail plus agréable",
    ],
    "primary.description": [
      "Bring your ideas, people and plans together in one calm place.",
      "Keep every project moving with a shared view of the details. Connect your ideas, make space for focused work and help everyone see what comes next.",
      "Réunissez idées, collègues et projets dans un espace calme et agréable.",
    ],
    "items.0.label": [
      "Watch a demo",
      "See the complete product in action",
      "Découvrez la démonstration",
    ],
    "items.1.label": [
      "Get started",
      "Start your next project with our team",
      "Lancez votre projet",
    ],
  },
  "features-icon-grid": {
    "primary.eyebrow": [
      "Built for real life",
      "Thoughtful features for the way your team actually works",
      "Pensé pour votre quotidien",
    ],
    "primary.heading": [
      "Less friction. More possibility.",
      "Everything your team needs to move from a promising idea to a confident launch",
      "Moins de friction, davantage de possibilités.",
    ],
    "primary.body": [
      "Simple tools help your team find its rhythm and keep moving.",
      "Give every project a clear starting point, keep the important details close and make it easier for people to contribute with confidence, wherever they work.",
      "Des outils simples aident votre équipe à trouver son rythme et à avancer ensemble.",
    ],
    "items.0.title": [
      "Start with clarity",
      "Give every new project a clear and useful starting point",
      "Commencez avec clarté",
    ],
    "items.0.body": [
      "Turn a big idea into a practical plan everyone can follow.",
      "Capture the purpose, agree on the next steps and give everyone a shared understanding before the work begins. A little clarity creates room for better decisions.",
      "Transformez une grande idée en un plan concret que toute votre équipe peut suivre.",
    ],
    "items.1.title": [
      "Work together",
      "Make collaboration feel natural across your whole team",
      "Travaillez en équipe",
    ],
    "items.1.body": [
      "Share useful context and welcome a fresh point of view.",
      "Bring conversations and useful context into the same place. Invite thoughtful feedback early, make decisions visible and keep every contributor connected to the work.",
      "Partagez le contexte utile et accueillez des regards nouveaux pour enrichir vos projets.",
    ],
    "items.2.title": [
      "Keep improving",
      "Learn from every launch and make the next one even better",
      "Continuez à progresser",
    ],
    "items.2.body": [
      "Notice what works, learn from it and take the next step.",
      "Look back at the work with curiosity. Keep the habits that help, adjust the details that slow you down and turn what you learn into a stronger next chapter.",
      "Observez ce qui fonctionne et avancez avec confiance vers la suite.",
    ],
  },
  "faq-simple": {
    "primary.eyebrow": [
      "A little more detail",
      "Helpful answers before we begin our next project together",
      "Quelques précisions utiles",
    ],
    "primary.heading": [
      "Questions, answered",
      "Everything you might want to know before getting started with our team",
      "Des réponses à vos questions",
    ],
    "primary.body": [
      "Here are a few things people often ask before we begin.",
      "Choosing a new partner is an important decision. We have gathered the practical details people ask about most, so you can take the next step with confidence.",
      "Voici quelques réponses aux questions que l'on nous pose souvent avant de commencer ensemble.",
    ],
    "items.0.question": [
      "How do we get started?",
      "What happens after we first get in touch about a project?",
      "Comment pouvons-nous commencer ?",
    ],
    "items.0.answer": [
      "Tell us what you have in mind. We will arrange a short conversation and suggest a useful next step.",
      "Start by sharing a little about your goals, your team and the challenge you want to solve. We will arrange a conversation, ask thoughtful questions and outline a practical way forward. There is no need to have every detail ready.",
      "Expliquez-nous votre idée. Nous organiserons un premier échange pour comprendre vos besoins et vous proposer une prochaine étape utile.",
    ],
    "items.1.question": [
      "Can we work remotely?",
      "Can your team collaborate with us across different places and time zones?",
      "Pouvons-nous travailler à distance ?",
    ],
    "items.1.answer": [
      "Yes. Clear notes, regular check-ins and shared tools keep everyone close to the work.",
      "Our process is designed for distributed teams. We combine clear written updates with focused conversations, agree on a comfortable rhythm and make sure decisions remain easy to find across locations and time zones.",
      "Oui. Des notes claires, des échanges réguliers et des outils partagés permettent à chacun de rester proche du projet.",
    ],
    "items.2.question": [
      "What happens after launch?",
      "How will you help us look after the work once our project is live?",
      "Que se passe-t-il après le lancement ?",
    ],
    "items.2.answer": [
      "We share a clear handover and help you plan the next chapter with confidence.",
      "Launch is a milestone rather than the end of the conversation. We provide a clear handover, walk your team through the important details and discuss the support and improvements that will be most useful next.",
      "Nous préparons une transmission claire et vous aidons à envisager la suite de votre projet avec confiance.",
    ],
  },
  "rich-text-body": {
    "primary.body": [
      "Good work starts with a clear idea. Give people the context they need, make the important details easy to find and leave room for a fresh perspective.",
      "Good work starts with a clear idea. Before choosing a direction, take time to understand the people who will use what you create. Ask useful questions, share what you learn and give the team a practical starting point.\n\nAs the work develops, make important decisions visible. Clear language, thoughtful structure and a little room to explore help everyone contribute. Small improvements build trust and make the finished experience feel considered.\n\nA launch is a chance to learn. Notice what helps, listen to the people using the work and carry those lessons into the next chapter.",
      "Un travail réussi commence par une idée claire. Donnez à chacun le contexte nécessaire, rendez les informations importantes faciles à trouver et gardez une place pour de nouvelles perspectives enrichissantes.",
    ],
  },
}

function document(field: SampleField, text: string): string {
  if (field.contract === "plain") return text
  return JSON.stringify({
    type: "doc",
    content: text.split("\n\n").map((part) => ({
      type: field.contract === "title" ? "heading" : "paragraph",
      ...(field.contract === "title" ? { attrs: { level: 3 } } : {}),
      content: part ? [{ type: "text", text: part }] : [],
    })),
  })
}
export function buildSamplePresets(
  type: string,
  fields: SampleField[]
): Record<SamplePreset, SampleValues> {
  return Object.fromEntries(
    SAMPLE_PRESETS.map((preset, index) => [
      preset.key,
      Object.fromEntries(
        fields.flatMap((field) => {
          const copy = COPY[type]?.[field.path]
          return copy ? [[field.path, document(field, copy[index])]] : []
        })
      ),
    ])
  ) as Record<SamplePreset, SampleValues>
}
export function sampleTextLength(
  values: SampleValues,
  fields: SampleField[]
): number {
  return Object.entries(values).reduce((sum, [path, value]) => {
    if (fields.find((field) => field.path === path)?.contract === "plain")
      return sum + value.length
    const text = (node: { text?: string; content?: (typeof node)[] }): string =>
      node.text ?? (node.content ?? []).map(text).join("")
    return sum + text(JSON.parse(value)).length
  }, 0)
}
