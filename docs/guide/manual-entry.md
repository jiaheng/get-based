# Manual Entry

If you have lab results but no PDF — for example, values written on paper, a result emailed as plain text, or numbers from a health device — you can enter them directly into getbased using the manual entry form.

## No AI Provider Needed

Manual entry does not use AI. You don't need an API key or any provider configured to use it.

## How to Use Manual Entry

1. In the sidebar, click **Manual Entry** (or find it in the navigation menu on mobile)
2. Select the **date** of the lab draw
3. Browse or search for markers by name or category
4. Enter the value for each marker you have results for
5. Click **Save**

The results are saved immediately and appear in your charts alongside any PDF-imported data.

::: tip You don't need to fill in everything
Only enter the markers you have results for. Leave the rest blank. getbased uses `null` for missing values and draws chart lines across gaps automatically.
:::

## Finding Markers

The marker list is organized by the same 17 categories used throughout the app (biochemistry, hormones, lipids, body composition, bone density, etc.). You can scroll through a category or use the search box to find a marker by name.

If a marker you're looking for doesn't appear in the list, you can create it. Click the **+** button next to "Categories" in the sidebar to [create a custom marker](./custom-markers.md#creating-custom-markers-manually) — define the name, unit, category, and reference range, then add values to it.

## Editing Existing Values

Click any value in the **detail modal** to edit it inline. Changed values show an **"edited ×"** badge — click the × to revert to the original imported value. Manually added values (no original to revert to) show a **"manual"** badge. You can also delete any value using the delete button.

::: tip Units
Enter values in whatever unit system you're currently using (US or SI). getbased automatically converts to its internal format when saving.
:::

## Use Cases

- Results from a doctor's visit where only a printout was provided
- Home test kits (cholesterol monitors, blood glucose meters, etc.)
- Entering a single marker you noticed was missing after a PDF import
- Historical values you've tracked in a spreadsheet
