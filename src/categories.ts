export interface Category {
  id: string;
  name: string;
  googleColorId: string;
  description: string;
  keywords: string[];
}

// Google Calendar color IDs:
// 1=Lavender, 2=Sage, 3=Grape, 4=Flamingo, 5=Banana,
// 6=Tangerine, 7=Peacock, 8=Graphite, 9=Blueberry, 10=Basil, 11=Tomato

export const categories: Category[] = [
  {
    id: "somatic",
    name: "Somatic & Embodiment",
    googleColorId: "3", // Grape
    description:
      "Tantra, Somatica, breathwork, somatic experiencing, body-based healing practices",
    keywords: [
      "tantra",
      "somatica",
      "breathwork",
      "somatic",
      "embodiment",
      "body practice",
    ],
  },
  {
    id: "dance_movement",
    name: "Dance & Movement",
    googleColorId: "4", // Flamingo
    description:
      "Ecstatic dance, contact improvisation, movement practices, embodied movement",
    keywords: [
      "ecstatic dance",
      "contact improv",
      "movement",
      "dance practice",
      "5rhythms",
    ],
  },
  {
    id: "systems_metacrisis",
    name: "Systems & Metacrisis",
    googleColorId: "8", // Graphite
    description:
      "Metacrisis, polycrisis, systems thinking, civilizational design, complexity",
    keywords: [
      "metacrisis",
      "polycrisis",
      "systems thinking",
      "complexity",
      "civilization",
      "game b",
    ],
  },
  {
    id: "environment",
    name: "Environment & Sustainability",
    googleColorId: "10", // Basil
    description:
      "Climate action, regenerative practices, sustainability, ecology, environmental justice",
    keywords: [
      "climate",
      "regenerative",
      "sustainability",
      "ecology",
      "environmental",
      "permaculture",
    ],
  },
  {
    id: "social_impact",
    name: "Social Impact & Community",
    googleColorId: "11", // Tomato
    description:
      "Civic engagement, activism, community building, mutual aid, social justice",
    keywords: [
      "civic",
      "activism",
      "community building",
      "mutual aid",
      "social justice",
      "organizing",
    ],
  },
  {
    id: "learning",
    name: "Learning & Knowledge",
    googleColorId: "9", // Blueberry
    description:
      "Lectures, salons, discussions, book clubs, intellectual gatherings, panels",
    keywords: [
      "lecture",
      "salon",
      "discussion",
      "book club",
      "panel",
      "talk",
      "seminar",
    ],
  },
  {
    id: "skills",
    name: "Skills & Workshops",
    googleColorId: "5", // Banana
    description:
      "Hands-on workshops, skill-building sessions, practice-based learning",
    keywords: [
      "workshop",
      "skill",
      "hands-on",
      "training",
      "masterclass",
      "practicum",
    ],
  },
  {
    id: "multiday",
    name: "Multi-day Immersive",
    googleColorId: "6", // Tangerine
    description: "Retreats, intensives, multi-day workshops, immersive programs",
    keywords: [
      "retreat",
      "intensive",
      "multi-day",
      "immersive",
      "residency",
    ],
  },
  {
    id: "conference",
    name: "Conferences & Summits",
    googleColorId: "7", // Peacock
    description: "Conferences, symposiums, summits, large-scale gatherings",
    keywords: [
      "conference",
      "summit",
      "symposium",
      "forum",
      "congress",
    ],
  },
  {
    id: "online",
    name: "Online & Zoom",
    googleColorId: "1", // Lavender
    description:
      "Virtual events, Zoom calls, online workshops, webinars, livestreams",
    keywords: [
      "zoom",
      "online",
      "virtual",
      "webinar",
      "livestream",
      "remote",
    ],
  },
];

export function getCategoryById(id: string): Category | undefined {
  return categories.find((c) => c.id === id);
}

export function getCategorySummary(): string {
  return categories
    .map((c) => `- ${c.id}: ${c.name} — ${c.description}`)
    .join("\n");
}
