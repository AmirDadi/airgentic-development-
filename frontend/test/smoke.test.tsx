import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../src/App";

describe("infra smoke", () => {
  it("renders the app shell", () => {
    render(<App />);
    expect(screen.getByText("Agent Team Dashboard")).toBeInTheDocument();
  });
});
