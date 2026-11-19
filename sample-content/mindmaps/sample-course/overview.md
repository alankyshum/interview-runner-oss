# Sliding windows

## What it is
- A window is a run of neighbouring items in a list or string.
- Sliding it means moving both ends forward instead of starting over.
  - One item enters on the right.
  - One item leaves on the left.

## Why it is fast
- The naive way recomputes every window from scratch: about n × k steps.
- Sliding updates the previous answer: about n steps.
  - Add the item that entered.
  - Subtract the item that left.

## Fixed-size windows
- The window always holds exactly k items.
- Typical questions
  - Largest sum of k consecutive numbers.
  - Average of every k-day period.

## Variable-size windows
- Grow the right end until a rule breaks.
- Shrink the left end until the rule holds again.
- Typical questions
  - Longest stretch without a repeated character.
  - Shortest run whose sum reaches a target.

## Edge cases to say out loud
- The list is shorter than the window.
- k is zero or negative.
- Negative numbers: the best window is not always the latest one.
