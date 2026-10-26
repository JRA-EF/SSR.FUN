import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

const LABELS = ["Very poor", "Poor", "Okay", "Good", "Excellent"];

/** 1-5 star picker. Hovering previews a rating; arrow keys move between stars. */
export function StarRating({ value, onChange, size = "md" }: { value: number; onChange: (rating: number) => void; size?: "md" | "lg" }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  const icon = size === "lg" ? "w-9 h-9" : "w-7 h-7";

  return (
    <div className="flex flex-col items-center gap-2">
      <div role="radiogroup" aria-label="Rating" className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
        {LABELS.map((label, i) => {
          const rating = i + 1;
          const on = rating <= shown;
          return (
            <button
              key={rating}
              type="button"
              role="radio"
              aria-checked={value === rating}
              aria-label={`${rating} star${rating === 1 ? "" : "s"}: ${label}`}
              tabIndex={value ? (value === rating ? 0 : -1) : rating === 1 ? 0 : -1}
              onMouseEnter={() => setHover(rating)}
              onFocus={() => setHover(rating)}
              onBlur={() => setHover(0)}
              onClick={() => onChange(rating)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                  e.preventDefault();
                  onChange(Math.min(5, (value || 0) + 1));
                } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                  e.preventDefault();
                  onChange(Math.max(1, (value || 2) - 1));
                }
              }}
              className="p-1 rounded-md transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Star className={cn(icon, "transition-colors", on ? "text-action fill-action" : "text-muted-foreground/50")} strokeWidth={1.5} />
            </button>
          );
        })}
      </div>
      <span className="text-xs text-muted-foreground h-4" aria-live="polite">
        {shown ? LABELS[shown - 1] : ""}
      </span>
    </div>
  );
}
