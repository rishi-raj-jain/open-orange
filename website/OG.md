# Open Graph images

Link previews (Slack, X, LinkedIn, iMessage, GitHub) are rendered from a
template on every `pnpm --dir website build`. No rendered PNG is committed.

| Image | Size | Published at | Used by |
| --- | --- | --- | --- |
| Site card | 1200×630 | `/og.png` | Every page except the docs |
| Docs cards | 1200×630 | `/og/docs/….png`, one per docs page | Each docs page |
| GitHub social preview | 1280×640 | `/og/github.png` | Uploaded by hand to the repository |

## Where things live

- `src/og/cards.ts`: the templates. `siteCard` is the site card and the GitHub
  preview; `docsCard` is the docs card. Layout, sizes and colors are here.
- `src/og/shatter.ts`: the break-glass box a moment after the hammer hits it.
  It ports the shatter animation in `src/components/BreakGlass.astro` (same
  fracture, shard physics and hammer swing) with a fixed seed, and draws one
  frame as SVG. `MOMENT` picks the frame and `IMPACT` where the hammer lands.
- `src/og/render.ts`: loads the fonts and images and renders a card to PNG with
  [Satori](https://github.com/vercel/satori) (layout to SVG) and
  [resvg](https://github.com/thx/resvg-js) (SVG to PNG).
- `src/pages/og.png.ts`, `src/pages/og/github.png.ts` and
  `src/pages/og/[...page].ts`: the endpoints that publish the images.
- `src/layouts/Base.astro` and `src/layouts/Docs.astro`: the `og:image` and
  `twitter:image` tags that point at them.

## Change the content

- **Headline and the line under it**: `HERO.title` and `HERO.lede` in
  `src/data/site.ts`. The home page hero reads the same values, so the card
  and the site stay in step.
- **Cloud logos**: `CLOUDS` in `src/data/clouds.ts` (SVGs in
  `src/assets/migrator/`). `cloudRow()` in `cards.ts` draws them along the
  bottom of every card; `OPTICAL` there evens out their visual weight.
- **Docs title, description and section**: the page's frontmatter in
  `docs/*.mdx` or `docs/modules/*.mdx`, and its sidebar group in
  `src/components/docs/nav.ts`. The two docs pages written in Astro take theirs
  from `src/data/docs-pages.ts`. A new doc gets a card with no extra work.
- **Illustration**: the break-glass box and hammer are the photos the home
  page hero uses: `public/images/break-glass-open.webp` (the box without
  glass), `break-glass-pane.webp` (the glass the shards are cut from),
  `break-glass.webp` (the box intact) and `hammer.webp`. The logo is
  `public/images/logo.png`. Replace those files to change both the site and
  the cards; `breakGlass()` in `cards.ts` places them, and
  `breakGlass(…, { intact: true })` shows the box before the hit. If the hero's
  animation changes, update `shatter.ts` to match.
- **Fonts**: Inter 400, 500 and 600 from `@fontsource/inter`. Satori can't read
  the site's variable WOFF2 files.

## Preview a change

Run the dev server and open an image. It re-renders on every request, so
reload after each edit:

```sh
pnpm --dir website dev
```

- http://localhost:4321/og.png
- http://localhost:4321/og/github.png
- http://localhost:4321/og/docs/bindings/kv.png/ (in dev, docs cards need the
  trailing slash; the build writes `og/docs/bindings/kv.png`)

Or build and open the files in `website/dist/og.png` and `website/dist/og/`.
On a pull request, the preview deployment serves the same paths.

## Update the GitHub social preview

GitHub has no API for the social preview, so upload it by hand after the card
changes:

1. Get the image: build and take `website/dist/og/github.png`, or download
   `https://openorange.dev/og/github.png` once the change is deployed.
2. On GitHub, open the repository's **Settings → General**.
3. Under **Social preview**, choose **Edit → Upload an image…** and pick the file.
