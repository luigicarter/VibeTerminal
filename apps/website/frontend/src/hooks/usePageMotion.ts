import { useEffect } from "react";

export function usePageMotion(route: string) {
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(
      ".hero__copy, .workspace-preview, .section-heading, .feature-grid, .orchestrator-spotlight, .mode-card, .platform-list, .download-card, .waitlist-section, .product-hero, .product-shot, .process-grid, .product-details, .product-crosslink, .capability-grid, .request-list, .agent-mode-grid, .agent-catalog, .voice-experience, .voice-spotlight, .workflow-visual, .pricing-card"
    )).filter(element => !element.parentElement?.closest("[data-reveal]"));
    if (preference.matches || !("IntersectionObserver" in window)) return;
    const reveal = (element: HTMLElement) => { element.dataset.revealed = "true"; };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        reveal(entry.target as HTMLElement);
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.06, rootMargin: "0px 0px -24px 0px" });
    for (const element of candidates) {
      element.dataset.reveal = "";
      // Above-the-fold content enters once; everything remains in the normal tab order.
      if (element.getBoundingClientRect().top < window.innerHeight) requestAnimationFrame(() => reveal(element));
      else observer.observe(element);
    }
    const onFocus = (event: FocusEvent) => {
      const element = (event.target as HTMLElement)?.closest<HTMLElement>("[data-reveal]");
      if (element) reveal(element);
    };
    const onPreference = () => { if (preference.matches) candidates.forEach(reveal); };
    document.addEventListener("focusin", onFocus);
    preference.addEventListener("change", onPreference);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocus);
      preference.removeEventListener("change", onPreference);
      candidates.forEach(element => { delete element.dataset.reveal; delete element.dataset.revealed; });
    };
  }, [route]);
}
