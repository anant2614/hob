import { memo, type ReactNode } from "react";
import { Streamdown } from "streamdown";

/**
 * Model output can carry instructions planted in a web page, such as an image
 * whose URL smuggles out your memory. So images from model output are never
 * loaded, and links open in a new tab without a referrer.
 */
function BlockedImage({ alt, src }: { alt?: string; src?: string | Blob }) {
  const where = typeof src === "string" ? src : "";
  return (
    <span className="blocked-image" title={where === "" ? undefined : `Not loaded: ${where}`}>
      Image not shown{alt ? `: ${alt}` : ""}
    </span>
  );
}

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href === undefined || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

const COMPONENTS = { img: BlockedImage, a: SafeLink };
const CONTROLS = { code: { copy: true, download: false }, table: false, mermaid: false, image: false } as const;

/** Loaded lazily: Streamdown is most of the app's weight, and plain text is fine for the first moment. */
export default memo(function Markdown({ text, streaming }: { readonly text: string; readonly streaming: boolean }) {
  return (
    <Streamdown
      className="prose-hob"
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      components={COMPONENTS as never}
      controls={CONTROLS}
      lineNumbers={false}
    >
      {text}
    </Streamdown>
  );
});
