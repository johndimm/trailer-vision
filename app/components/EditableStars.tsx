'use client'

import { useState } from 'react'

type StarColor = 'red' | 'blue' | 'amber' | 'violet'

interface EditableStarsProps {
  rating: number | null
  onChange: (value: number | null) => void
  color: StarColor
  ariaLabel?: string
}

const colorMap: Record<StarColor, string> = {
  red: 'text-red-500',
  blue: 'text-blue-500',
  amber: 'text-amber-400',
  violet: 'text-violet-500',
}

export function EditableStars({
  rating,
  onChange,
  color,
  ariaLabel,
}: EditableStarsProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const display = hovered ?? rating ?? 0

  return (
    <div
      className="flex select-none cursor-pointer"
      style={{ gap: '0.1rem' }}
      onMouseLeave={() => setHovered(null)}
      role="slider"
      aria-label={ariaLabel || 'Rating'}
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={rating ?? 0}
    >
      {[1, 2, 3, 4, 5].map(star => {
        const isFull = display >= star
        const isHalf = !isFull && display >= star - 0.5
        return (
          <div
            key={star}
            className="relative"
            style={{ fontSize: '1.0rem', lineHeight: 1 }}
          >
            <span className="text-zinc-300">★</span>
            {(isFull || isHalf) && (
              <span
                className={`absolute inset-0 overflow-hidden ${colorMap[color]}`}
                style={isHalf ? { clipPath: 'inset(0 50% 0 0)' } : {}}
              >
                ★
              </span>
            )}
            <span
              className="absolute inset-y-0 left-0 w-1/2 cursor-pointer"
              style={{ pointerEvents: 'auto' }}
              onMouseEnter={() => setHovered(star - 0.5)}
              onClick={() => onChange(rating === star - 0.5 ? null : star - 0.5)}
            />
            <span
              className="absolute inset-y-0 right-0 w-1/2 cursor-pointer"
              style={{ pointerEvents: 'auto' }}
              onMouseEnter={() => setHovered(star)}
              onClick={() => onChange(rating === star ? null : star)}
            />
          </div>
        )
      })}
    </div>
  )
}
