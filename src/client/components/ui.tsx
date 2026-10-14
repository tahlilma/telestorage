"use client";
import { clsx, type ClassValue } from "clsx";
import { X } from "lucide-react";
import { motion, useDragControls, type PanInfo } from "motion/react";
import { Dialog, Tooltip as RTooltip } from "radix-ui";
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { useIsMobile } from "../hooks";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

type Variant = "primary" | "accent" | "outline" | "ghost" | "soft" | "danger";

const variants: Record<Variant, string> = {
  // Solid ink block (cream at night): the main action everywhere.
  primary: "bg-invert text-on-invert hover:bg-accent hover:text-on-accent",
  accent: "bg-accent text-on-accent hover:bg-accent-hover",
  outline: "border-[1.5px] border-line-strong bg-transparent text-ink hover:bg-invert hover:text-on-invert",
  ghost: "text-ink-2 hover:bg-surface-3 hover:text-ink",
  soft: "bg-surface-3 text-ink hover:bg-line",
  danger: "bg-danger text-white hover:brightness-95 dark:text-[#1a0603]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }>(
  function Button({ className, variant = "primary", size = "md", ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex select-none items-center justify-center gap-2 font-medium transition-[background-color,color,transform,box-shadow] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          size === "sm" ? "h-9 px-3.5 text-[13.5px]" : size === "lg" ? "h-12 px-6 text-[15.5px]" : "h-11 px-5 text-[14.5px]",
          variants[variant],
          className,
        )}
        {...props}
      />
    );
  },
);

export function Tooltip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RTooltip.Root delayDuration={400}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="z-[70] bg-invert px-2 py-1 text-[12.5px] font-medium text-on-invert animate-fade-in">
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; tooltip?: boolean }>(
  function IconButton({ label, active, className, tooltip = true, ...props }, ref) {
    const btn = (
      <button
        ref={ref}
        aria-label={label}
        className={cn(
          "inline-flex size-10 shrink-0 items-center justify-center text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink active:bg-line disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent [&_svg]:size-[19px]",
          active && "bg-invert text-on-invert hover:bg-invert hover:text-on-invert",
          className,
        )}
        {...props}
      />
    );
    return tooltip ? <Tooltip label={label}>{btn}</Tooltip> : btn;
  },
);

/** Two quarter circles chasing each other. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-5 animate-spin text-accent", className)} aria-hidden style={{ animationDuration: "0.9s" }}>
      <path d="M12 2a10 10 0 0 1 10 10H12Z" fill="currentColor" />
      <path d="M12 22A10 10 0 0 1 2 12h10Z" fill="var(--ink)" />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center border border-line-strong/40 border-b-2 bg-surface px-1.5 text-[11px] font-medium text-ink-2">
      {children}
    </kbd>
  );
}

export function ProgressBar({ value, className, tone = "accent" }: { value: number; className?: string; tone?: "accent" | "success" | "danger" | "ink" }) {
  const color = tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : tone === "ink" ? "bg-invert" : "bg-accent";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden bg-surface-3", className)}>
      <div className={cn("h-full transition-[width] duration-300 ease-out", color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/**
 * Dialog on desktop, bottom sheet on phones (drag the handle down to close).
 * Content, focus trapping and Escape handling are shared.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  kicker,
  description,
  children,
  footer,
  width = "max-w-md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  kicker?: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const mobile = useIsMobile();
  const drag = useDragControls();
  const header = (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        {kicker ? <div className="label mb-1.5 text-accent">{kicker}</div> : null}
        <Dialog.Title className="text-[22px] font-semibold leading-7 tracking-[-0.02em] text-ink">{title}</Dialog.Title>
        {description ? (
          <Dialog.Description className="mt-1.5 text-[14.5px] leading-relaxed text-ink-2">{description}</Dialog.Description>
        ) : (
          <Dialog.Description className="sr-only">{typeof title === "string" ? title : (kicker ?? "Dialog")}</Dialog.Description>
        )}
      </div>
      {!mobile ? (
        <Dialog.Close asChild>
          <IconButton label="Close" tooltip={false} className="-mr-2 -mt-2">
            <X />
          </IconButton>
        </Dialog.Close>
      ) : null}
    </div>
  );
  const body = (
    <>
      {header}
      {children ? <div className="mt-5">{children}</div> : null}
      {footer ? <div className="mt-6 flex flex-wrap justify-end gap-2 max-sm:[&>*]:flex-1">{footer}</div> : null}
    </>
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[#0b0b0b]/45 backdrop-blur-[2px] animate-fade-in" />
        {mobile ? (
          <Dialog.Content asChild aria-describedby={undefined}>
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 40 }}
              drag="y"
              dragControls={drag}
              dragListener={false}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.6 }}
              onDragEnd={(_e, info: PanInfo) => {
                if (info.offset.y > 110 || info.velocity.y > 600) onOpenChange(false);
              }}
              className="fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto border-t-[1.5px] border-line-strong bg-surface px-5 pb-6 outline-none safe-bottom"
            >
              <div className="sticky top-0 -mx-5 mb-2 flex h-7 cursor-grab touch-none items-center justify-center bg-surface" onPointerDown={(e) => drag.start(e)}>
                <span className="h-1.5 w-12 bg-line" />
              </div>
              {body}
            </motion.div>
          </Dialog.Content>
        ) : (
          <Dialog.Content
            className={cn(
              "fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border-[1.5px] border-line-strong bg-surface p-6 shadow-hard outline-none animate-pop-in",
              width,
            )}
          >
            {body}
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TextField(props: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: ReactNode; error?: string | null; ref?: React.Ref<HTMLInputElement> }) {
  const { label, hint, error, className, ref, id, ...rest } = props;
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div>
      {label ? (
        <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-ink-2">
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cn(
          "h-12 w-full border-[1.5px] border-line-strong bg-surface px-4 text-[15px] text-ink outline-none transition-[box-shadow,border-color] placeholder:text-ink-3 focus:shadow-hard-sm",
          error && "border-danger focus:shadow-[3px_3px_0_var(--danger)]",
          className,
        )}
        {...rest}
      />
      {error ? <p className="mt-1.5 text-[13px] font-medium text-danger">{error}</p> : hint ? <p className="mt-1.5 text-[13px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; id?: string }) {
  const autoId = useId();
  const sid = id ?? autoId;
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={sid} className="min-w-0 cursor-pointer">
        <span className="block text-[14.5px] font-medium text-ink">{label}</span>
        {description ? <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">{description}</span> : null}
      </label>
      <button
        id={sid}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-7 w-12 shrink-0 border-[1.5px] border-line-strong transition-colors", checked ? "bg-accent" : "bg-surface-3")}
      >
        <span className={cn("absolute top-[3px] size-[17px] bg-invert transition-transform duration-200 ease-out", checked ? "translate-x-[23px]" : "translate-x-[3px]")} />
      </button>
    </div>
  );
}

/** Square tabs with a sliding indicator. */
export function Tabs<T extends string>({ value, onChange, options, className, layoutId }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; className?: string; layoutId: string }) {
  return (
    <div role="tablist" className={cn("flex items-center gap-1 overflow-x-auto", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn("relative h-9 shrink-0 px-3.5 text-[14px] font-medium transition-colors", on ? "text-on-invert" : "text-ink-2 hover:text-ink")}
          >
            {on ? <motion.span layoutId={layoutId} className="absolute inset-0 bg-invert" transition={{ type: "spring", stiffness: 500, damping: 38 }} /> : null}
            <span className="relative flex items-center gap-1.5">
              {o.label}
              {o.count !== undefined ? <span className={cn("text-[12px] tabular", on ? "text-on-invert/70" : "text-ink-3")}>{o.count}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "sky" | "ink"; className?: string }) {
  const tones = {
    neutral: "bg-surface-3 text-ink-2",
    accent: "bg-accent text-on-accent",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
    sky: "bg-sky-soft text-sky",
    ink: "bg-invert text-on-invert",
  } as const;
  return <span className={cn("inline-flex h-[22px] items-center gap-1 px-2 text-[11.5px] font-semibold", tones[tone], className)}>{children}</span>;
}
