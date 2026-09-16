window.MiniShopCheats = {
  "mini-shop-red-second-cheapest": [
    { tool: "chrome_click", params: { selector: "button[aria-label=\"add Ruby Notebook\"]" } },
    { tool: "chrome_click", params: { selector: "#checkout" } }
  ],
  run: {
    "mini-shop-red-second-cheapest": async () => {
      document.querySelector('button[aria-label="add Ruby Notebook"]').click();
      document.querySelector('#checkout').click();
    }
  }
};
