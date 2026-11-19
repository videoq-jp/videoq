import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/digital-agency/cn"
import { DialogPortalContext } from "./dialog"

const Select = SelectPrimitive.Root

const SelectValue = SelectPrimitive.Value

const selectTriggerVariants = cva(
  "group/select relative inline-flex w-fit max-w-full align-baseline appearance-none items-center justify-between gap-2 rounded-8 border border-solid-gray-600 bg-white pl-4 pr-4 py-[calc(11/16*1rem)] text-oln-16N-100 text-solid-gray-800 hover:border-black data-[size=sm]:h-10 data-[size=md]:h-12 data-[size=lg]:h-14 aria-[invalid=true]:border-error-1 aria-[invalid=true]:hover:border-red-1000 focus:outline focus:outline-4 focus:outline-black focus:outline-offset-[calc(2/16*1rem)] focus:ring-[calc(2/16*1rem)] focus:ring-yellow-300 aria-disabled:border-solid-gray-300 aria-disabled:bg-solid-gray-50 aria-disabled:text-solid-gray-420 aria-disabled:pointer-events-none aria-disabled:forced-colors:text-[GrayText] aria-disabled:forced-colors:border-[GrayText] [&>span]:line-clamp-1 [&[data-disabled]]:border-solid-gray-300 [&[data-disabled]]:bg-solid-gray-50 [&[data-disabled]]:text-solid-gray-420 [&[data-disabled]]:pointer-events-none",
  {
    variants: {
      blockSize: {
        lg: "",
        md: "",
        sm: "",
      },
    },
    defaultVariants: {
      blockSize: "lg",
    },
  }
)

type SelectTriggerProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Trigger
> &
  VariantProps<typeof selectTriggerVariants> & {
    isError?: boolean
  }

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, children, isError, blockSize = "lg", ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    data-slot="select-trigger"
    className={cn(selectTriggerVariants({ blockSize }), className)}
    aria-invalid={isError || undefined}
    data-size={blockSize}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <svg
        aria-hidden={true}
        viewBox="0 0 24 24"
        className="pointer-events-none size-4 shrink-0 fill-current text-solid-gray-900 group-aria-disabled/select:text-solid-gray-420 group-data-[disabled]/select:text-solid-gray-420 forced-colors:text-[CanvasText] group-aria-disabled/select:forced-colors:text-[GrayText] group-data-[disabled]/select:forced-colors:text-[GrayText]"
      >
        <path d="M12 17.1 3 8l1-1 8 8 8-8 1 1z" />
      </svg>
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    data-slot="select-scroll-up-button"
    className={cn(
      "flex cursor-default items-center justify-center py-1 text-solid-gray-800",
      className
    )}
    {...props}
  >
    <ChevronUp className="size-4" />
  </SelectPrimitive.ScrollUpButton>
))
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    data-slot="select-scroll-down-button"
    className={cn(
      "flex cursor-default items-center justify-center py-1 text-solid-gray-800",
      className
    )}
    {...props}
  >
    <ChevronDown className="size-4" />
  </SelectPrimitive.ScrollDownButton>
))
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => {
  const dialogContainer = React.useContext(DialogPortalContext)

  return (
    <SelectPrimitive.Portal container={dialogContainer ?? undefined}>
      <SelectPrimitive.Content
        ref={ref}
        data-slot="select-content"
        className={cn(
          "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-8 border border-solid-gray-600 bg-white text-solid-gray-800 shadow-1",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "w-full min-w-[var(--radix-select-trigger-width)]"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    data-slot="select-item"
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-8 py-[calc(11/16*1rem)] pl-4 pr-10 text-oln-16N-100 text-solid-gray-800 outline-none focus:bg-key-200 focus:text-key-1000 data-[disabled]:pointer-events-none data-[disabled]:text-solid-gray-420 data-[disabled]:forced-colors:text-[GrayText]",
      className
    )}
    {...props}
  >
    <span className="absolute right-4 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName
export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem }
