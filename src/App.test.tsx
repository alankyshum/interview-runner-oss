import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import App from "./App";

describe("practice shell", () => {
  it("renders the course shell while the API is unavailable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    render(<MantineProvider><App /></MantineProvider>);
    expect(await screen.findByText("offline")).toBeInTheDocument();
  });
  it('routes directly to the design system gallery', () => {
    history.replaceState({}, '', '/design-system');
    render(<MantineProvider><App /></MantineProvider>);
    expect(screen.getByRole('heading', { name: 'Design system' })).toBeInTheDocument();
    history.replaceState({}, '', '/');
  });
});
