import {
  Toast,
  ToastClose,
  ToastCopy,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { useToast } from "@/hooks/use-toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        // Plain-string content is copyable via the copy control -- exactly
        // the toasts that carry signatures/decoded errors worth pasting.
        const copyText = [title, description].filter((part) => typeof part === "string").join("\n")
        return (
          <Toast key={id} {...props}>
            {/* min-w-0 lets the text column actually shrink/wrap inside the
                flex row -- without it, an unbreakable signature string sets
                the column's intrinsic width and pushes the toast offscreen. */}
            <div className="grid min-w-0 flex-1 gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            {copyText && <ToastCopy text={copyText} />}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
