# DESIGN.md: "Night Shift" (picked by Kevin, D-905, 2026-11-18)

World: a founder's desk at 2 AM. The work keeps happening while they sleep. Dark, cinematic, calm, real. Photography of real-feeling objects (laptop with abstract charts, phone with a waveform, packed shipping boxes at dawn), never people, logos or readable screen text. Dark is the brand's single mode (use scene: a founder checking a referral late, on a laptop or phone).

Mode: Persuade (marketing and funnel pages). Articles and legal pages: Read.

## Tokens (src/css/site.css :root)
bg #0E0F11 · surface #16181B · surface-2 #1C1F23 · line rgba(233,230,223,.12) · line-strong rgba(233,230,223,.35) · text #E9E6DF · muted #A39E94 · accent #F2A63B (signal amber: primary CTA, key numbers, focus ring, link underline; nothing else) · field #08090A · field-line #7A766E.
Radius: buttons pill 999px; panels 14px; inputs 10px.
Type: display Inter Tight 600 (tracking -0.02em, balanced), body Inter 400/500, data JetBrains Mono 500 (numbers, timestamps only). Self-hosted woff2.
Grain: one fixed overlay at .035 opacity, off on phones.

## Components
Photo hero with left scrim; proof numbers in mono amber; "While you sleep" sticky stack of timestamped cards (desktop pins and stacks, phone stacks plainly); 3-step ladder with the first step raised; founder figure with real headshot; forms with labels above, errors below, amber submit; native details FAQ; CTA band; four-column footer.

## Motion
One authored moment per page (home: the sticky stack). Hero image settles 1.04 to 1 on load. Reveal-on-enter for blocks. Proof count-up once. All progressive enhancement; reduced motion = static.

## Bans for this world
Eyebrow/kicker labels above headings; three equal icon cards; gradient text; glass as decoration; colored thick side borders; emoji or unicode icons; fake UI screenshots; space or brain imagery; prices.
