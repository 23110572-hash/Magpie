import React from "react";

// Base positions (vw, vh) spread over the screen; each cloud gets a random jitter, size and path on load.
const SLOTS: [number, number, boolean][] = [
  [-8, 2, false], [30, -4, true], [58, 5, false], [4, 33, false], [44, 26, false], [74, 40, true], [18, 60, true],
];
const rand = (min: number, max: number) => min + Math.random() * (max - min);

// Computed once per page load (module scope), so every visit gets a slightly different sky.
const CLOUDS = SLOTS.map(([x, y, desktopOnly], i) => {
  const duration = rand(70, 120);
  return {
    id: `magpie-cloud-${i}`,
    left: x + rand(-4, 4),
    top: y + rand(-3, 3),
    width: Math.round(rand(380, 700)),
    seed: Math.floor(rand(1, 9999)),
    path: 1 + Math.floor(Math.random() * 4),
    duration,
    delay: -rand(0, duration),
    direction: Math.random() < 0.5 ? "alternate" : "alternate-reverse",
    breathe: rand(16, 28),
    breatheDelay: -rand(0, 20),
    opacity: rand(0.8, 1),
    desktopOnly,
  };
}).sort((a, b) => a.width - b.width); // bigger (nearer) clouds are painted on top

const SPARKS: [string, string, number][] = [
  ["12%", "22%", 0], ["26%", "68%", 1.2], ["38%", "12%", 2.1], ["52%", "84%", 0.6], ["64%", "30%", 1.8],
  ["18%", "90%", 2.6], ["80%", "55%", 0.9], ["72%", "8%", 3.1], ["44%", "48%", 1.5], ["88%", "76%", 2.3],
];

/**
 * One volumetric cloud: soft ellipses whose edges are torn into wisps by fractal noise
 * (feTurbulence + feDisplacementMap). Layers: white body, blue-grey underside, faint base shadow, sunlit top.
 */
const RealisticCloud: React.FC<{ id: string; seed: number }> = ({ id, seed }) => {
  const layer = (name: string, blur: number, octaves: number, frequency: number, scale: number, offset: number) => (
    <filter id={`${id}-${name}`} filterUnits="userSpaceOnUse" x="0" y="0" width="800" height="480"
      colorInterpolationFilters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="soft" />
      <feTurbulence type="fractalNoise" baseFrequency={frequency} numOctaves={octaves} seed={seed + offset} result="noise" />
      <feDisplacementMap in="soft" in2="noise" scale={scale} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
  return (
    <svg viewBox="0 0 800 480" className="w-full h-auto" aria-hidden="true" focusable="false">
      <defs>
        {layer("body", 14, 4, 0.011, 170, 0)}
        {layer("under", 26, 3, 0.012, 140, 7)}
        {layer("base", 24, 2, 0.014, 100, 13)}
        {layer("light", 18, 4, 0.013, 120, 21)}
      </defs>
      <ellipse cx="400" cy="235" rx="255" ry="118" fill="#ffffff" filter={`url(#${id}-body)`} />
      <ellipse cx="410" cy="278" rx="212" ry="82" fill="rgba(163, 190, 220, 0.55)" filter={`url(#${id}-under)`} />
      <ellipse cx="415" cy="305" rx="165" ry="50" fill="rgba(98, 128, 166, 0.2)" filter={`url(#${id}-base)`} />
      <ellipse cx="370" cy="195" rx="160" ry="68" fill="rgba(255, 255, 255, 0.95)" filter={`url(#${id}-light)`} />
    </svg>
  );
};

/** Animated sky for the Home page: realistic clouds wandering over slowly moving light-blue glows. */
export const CloudBackground: React.FC = () => (
  <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none print:hidden" aria-hidden="true">
    {/* Sky */}
    <div className="absolute inset-0 bg-gradient-to-b from-sky-100 via-blue-50 to-[#f8fafc]" />

    {/* Slow drifting glows */}
    <div className="magpie-blob absolute -top-48 -left-40 w-[44rem] h-[44rem] rounded-full bg-sky-300/35 blur-[110px]"
      style={{ animationDuration: "32s" }} />
    <div className="magpie-blob absolute top-1/4 -right-48 w-[40rem] h-[40rem] rounded-full bg-indigo-300/25 blur-[120px]"
      style={{ animationDuration: "41s", animationDelay: "-12s" }} />
    <div className="magpie-blob absolute -bottom-56 left-1/4 w-[48rem] h-[48rem] rounded-full bg-cyan-200/40 blur-[120px]"
      style={{ animationDuration: "37s", animationDelay: "-20s" }} />

    {/* Clouds: each wanders on its own curved path (transform/opacity only, so it stays smooth) */}
    {CLOUDS.map((c) => (
      <div key={c.id} className={`magpie-cloud ${c.desktopOnly ? "hidden md:block" : ""}`}
        style={{
          left: `${c.left}vw`, top: `${c.top}vh`, width: `min(${c.width}px, 92vw)`,
          animation: `magpie-wander-${c.path} ${c.duration}s ease-in-out ${c.delay}s infinite ${c.direction}, ` +
            `magpie-breathe ${c.breathe}s ease-in-out ${c.breatheDelay}s infinite`,
        }}>
        <div style={{ opacity: c.opacity }}>
          <RealisticCloud id={c.id} seed={c.seed} />
        </div>
      </div>
    ))}

    {/* Soft light behind the headline keeps the text crisp */}
    <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[64rem] h-[30rem] rounded-full bg-white/60 blur-[100px]" />

    {/* Twinkles */}
    {SPARKS.map(([left, top, delay], i) => (
      <span key={i} className="magpie-twinkle absolute w-1.5 h-1.5 rounded-full bg-sky-400/70"
        style={{ left, top, animationDelay: `${delay}s` }} />
    ))}

    {/* Blend into the page towards the bottom */}
    <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-b from-transparent to-[#f8fafc]" />
  </div>
);
