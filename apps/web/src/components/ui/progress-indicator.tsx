import * as React from "react"

import { cn } from "@/lib/digital-agency/cn"

type ProgressIndicatorType = "stacked" | "inlined" | "stacked-underlay"
type ProgressIndicatorSize = "lg" | "sm"

const progressIndicatorKeyframes = `
@keyframes digital-agency-spinner-rotate {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@keyframes digital-agency-spinner-group-rotate {
  0% { transform: rotate(0deg); }
  30% { transform: rotate(135deg); }
  100% { transform: rotate(180deg); }
}

@keyframes digital-agency-spinner-bar-rotate {
  0% { transform: rotate(0deg); }
  4% { transform: rotate(0deg); }
  30% {
    transform: rotate(360deg);
    animation-timing-function: cubic-bezier(0.5, 0.4, 0.3, 0.9);
  }
  100% { transform: rotate(540deg); }
}

@keyframes digital-agency-spinner-bar-dash {
  0% { stroke-dasharray: 8 92; stroke-dashoffset: 4; }
  30% { stroke-dasharray: 80 20; stroke-dashoffset: 40; }
  100% { stroke-dasharray: 8 92; stroke-dashoffset: 4; }
}

@keyframes digital-agency-linear-rotate {
  0% { stroke-dashoffset: 100; }
  100% { stroke-dashoffset: -100; }
}
`

type ProgressIndicatorProps = Omit<
  React.ComponentProps<"div">,
  "role" | "type"
> & {
  type: ProgressIndicatorType
  value?: number
  active?: boolean
}

const clampValue = (value: number) => Math.min(100, Math.max(0, value))

const ProgressIndicator = React.forwardRef<
  HTMLDivElement,
  ProgressIndicatorProps
>(
  (
    { children, className, type, value, active = true, style, ...rest },
    ref
  ) => {
    if (!active) return null

    const hasValue = value !== undefined && Number.isFinite(value)
    const normalizedValue = hasValue ? clampValue(value) : undefined
    const isIndeterminate = normalizedValue === undefined

    const mergedStyle: React.CSSProperties = {
      ...style,
      ...(normalizedValue !== undefined
        ? { ["--value" as string]: String(normalizedValue) }
        : {}),
    }

    return (
      <>
        <style
          dangerouslySetInnerHTML={{ __html: progressIndicatorKeyframes }}
        />
        <div
          ref={ref}
          data-slot="progress-indicator"
          className={cn(
            `
        group/progress-indicator flex justify-center items-center gap-y-4 gap-x-2 text-solid-gray-900 text-std-16N-170
        data-[type=stacked]:flex-col
        data-[type=stacked-underlay]:flex-col data-[type=stacked-underlay]:mx-auto data-[type=stacked-underlay]:box-border data-[type=stacked-underlay]:w-fit data-[type=stacked-underlay]:rounded-16 data-[type=stacked-underlay]:border data-[type=stacked-underlay]:border-solid-gray-500 data-[type=stacked-underlay]:bg-white
        data-[type=stacked-underlay]:has-[[data-indicator=spinner]]:min-w-[calc(128/16*1rem)] data-[type=stacked-underlay]:has-[[data-indicator=spinner]]:min-h-[calc(128/16*1rem)] data-[type=stacked-underlay]:has-[[data-indicator=spinner]]:p-4
        data-[type=stacked-underlay]:has-[[data-indicator=static]]:min-w-[calc(128/16*1rem)] data-[type=stacked-underlay]:has-[[data-indicator=static]]:min-h-[calc(128/16*1rem)] data-[type=stacked-underlay]:has-[[data-indicator=static]]:p-4
        data-[type=stacked-underlay]:has-[[data-indicator=linear]]:p-6
      `,
            className
          )}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={normalizedValue}
          data-type={type}
          data-indeterminate={isIndeterminate ? "" : undefined}
          style={mergedStyle}
          {...rest}
        >
          {children}
        </div>
      </>
    )
  }
)
ProgressIndicator.displayName = "ProgressIndicator"

// --- Spinner ---

const spinnerBarAnimationClass = `
  group-data-[indeterminate]/progress-indicator:[animation:digital-agency-spinner-bar-rotate_2.5s_cubic-bezier(0.4,0,0.3,1)_infinite,digital-agency-spinner-bar-dash_2.5s_cubic-bezier(0.4,0,0.3,1)_infinite]
  motion-reduce:![animation:none]
`

const spinnerOuterGroupAnimationClass = `
  group-data-[indeterminate]/progress-indicator:[animation:digital-agency-spinner-rotate_13s_linear_infinite]
  motion-reduce:![animation:none]
`

const spinnerInnerGroupAnimationClass = `
  group-data-[indeterminate]/progress-indicator:[animation:digital-agency-spinner-group-rotate_2.5s_linear_infinite]
  motion-reduce:![animation:none]
`

type ProgressIndicatorSpinnerProps = Omit<
  React.ComponentProps<"svg">,
  "children"
> & {
  size?: ProgressIndicatorSize
}

const ProgressIndicatorSpinner = React.forwardRef<
  SVGSVGElement,
  ProgressIndicatorSpinnerProps
>(({ size = "lg", className, ...rest }, ref) => {
  const isLg = size === "lg"
  const dimension = isLg ? 48 : 24
  const center = isLg ? 24 : 12
  const radius = isLg ? 22 : 8
  const outerRadius = isLg ? 23.5 : 9.5
  const strokeWidth = isLg ? 4 : 3

  return (
    <svg
      ref={ref}
      data-slot="progress-indicator-spinner"
      width={dimension}
      height={dimension}
      viewBox={`0 0 ${dimension} ${dimension}`}
      stroke="currentcolor"
      fill="none"
      aria-hidden={true}
      data-indicator="spinner"
      className={cn(className)}
      {...rest}
    >
      <circle
        className="stroke-current text-key-100 forced-colors:text-[Canvas]"
        cx={center}
        cy={center}
        r={radius}
        strokeWidth={strokeWidth}
      />
      <g
        className={`[transform-origin:center] ${spinnerOuterGroupAnimationClass}`}
      >
        <g
          className={`[transform-origin:center] ${spinnerInnerGroupAnimationClass}`}
        >
          <circle
            className={`
              text-key-1200 [stroke-dasharray:100] [transform:rotate(-90deg)] [transform-origin:center]
              [stroke-dashoffset:calc(100-clamp(0,var(--value,35),100))]
              forced-colors:text-[CanvasText]
              ${spinnerBarAnimationClass}
            `}
            cx={center}
            cy={center}
            r={radius}
            strokeWidth={strokeWidth}
            pathLength={100}
          />
        </g>
      </g>
      <circle
        className="text-key-1200 forced-colors:text-[CanvasText]"
        cx={center}
        cy={center}
        r={outerRadius}
        strokeWidth={1}
      />
    </svg>
  )
})
ProgressIndicatorSpinner.displayName = "ProgressIndicatorSpinner"

// --- Linear ---

const linearBarClass = `
  [stroke-dasharray:100]
  group-data-[indeterminate]/progress-indicator:[stroke-dasharray:35_65]
  group-data-[indeterminate]/progress-indicator:[animation:digital-agency-linear-rotate_4s_linear_infinite]
  motion-reduce:![animation:none]
`

type ProgressIndicatorLinearProps = Omit<
  React.ComponentProps<"svg">,
  "children"
> & {
  size?: ProgressIndicatorSize
}

const ProgressIndicatorLinear = React.forwardRef<
  SVGSVGElement,
  ProgressIndicatorLinearProps
>(({ size = "lg", className, ...rest }, ref) => {
  const width = size === "lg" ? 240 : 80

  return (
    <svg
      ref={ref}
      data-slot="progress-indicator-linear"
      width={width}
      height={4}
      viewBox={`0 0 ${width} 4`}
      stroke="currentcolor"
      fill="none"
      aria-hidden={true}
      data-indicator="linear"
      className={cn(className)}
      {...rest}
    >
      <line
        className="stroke-current text-key-100 forced-colors:text-[Canvas]"
        x1={0}
        y1={2}
        x2={width}
        y2={2}
        strokeWidth={4}
      />
      <line
        className={`
          text-key-1200 forced-colors:text-[CanvasText]
          [stroke-dashoffset:calc(100-clamp(0,var(--value,35),100))]
          ${linearBarClass}
        `}
        x1={0}
        y1={2}
        x2={width}
        y2={2}
        strokeWidth={4}
        pathLength={100}
      />
      <line
        className="text-key-1200 forced-colors:text-[CanvasText]"
        x1={0}
        y1={3.5}
        x2={width}
        y2={3.5}
        strokeWidth={1}
      />
    </svg>
  )
})
ProgressIndicatorLinear.displayName = "ProgressIndicatorLinear"
export { ProgressIndicator, ProgressIndicatorSpinner, ProgressIndicatorLinear }
