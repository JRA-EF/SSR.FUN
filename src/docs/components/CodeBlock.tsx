import { useState } from 'react'

/**
 * A code sample with a copy button. No syntax highlighter on purpose: the
 * docs must stay readable for non-developers, and a plain monospace block
 * in the native tokens is the lightest thing that does that. The <pre> is
 * keyboard-focusable so long lines can be scrolled without a mouse.
 */
export function CodeBlock({ code, title }: { code: string; title: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be denied (insecure context, permissions); the
      // text is still selectable by hand, so there is nothing else to do.
    }
  }

  return (
    <figure className="doc-code">
      <figcaption className="doc-code-head">
        <span>{title}</span>
        <button type="button" className="doc-copy" onClick={copy} aria-live="polite">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  )
}
