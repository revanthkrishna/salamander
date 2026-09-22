<!-- salamander-feedback-format: 2 -->
salamander 1.1.0\
**date exported:** 2026-09-21 21:40 utc-05:00\
**website:** example.com

## page "https://example.com/pricing"

### feedback 1

![feedback 1 — marked up by the reviewer](screenshots/1.png)

**note:** the "start trial" cta is misaligned on mobile

<details>
<summary>element data</summary>

```json
{
  "text": "start trial",
  "selector": "section.plans > div:nth-of-type(2) > a.btn",
  "xpath": "/html/body/main/section[2]/div[2]/a",
  "html": "<a class=\"btn btn-primary css-1k2j3h\" href=\"/signup?plan=team\" data-track=\"cta-team\">start trial</a>",
  "page_url": "https://www.example.com/pricing?plan=team",
  "note": "the \"start trial\" cta is misaligned on mobile",
  "id": 1,
  "normalised_url": "https://example.com/pricing",
  "page_title": "pricing — example",
  "created_at": "2026-09-20T10:15:30.000Z",
  "selection_rect": {
    "x": 412,
    "y": 1188,
    "width": 267,
    "height": 100
  },
  "viewport": {
    "width": 1280,
    "height": 720
  },
  "dpr": 2,
  "contained_elements": [
    {
      "tag": "a",
      "classes": {
        "semantic": [
          "btn",
          "btn-primary"
        ],
        "generated": [
          "css-1k2j3h"
        ]
      },
      "attrs": {
        "href": "/signup?plan=team",
        "data-track": "cta-team"
      },
      "text": "start trial"
    },
    {
      "tag": "span",
      "id": "price-team",
      "text": "$12 / seat"
    }
  ],
  "area_text": "team $12 / seat start trial"
}
```

</details>

### feedback 3

![feedback 3](screenshots/3.png)

**note:** the comparison table overflows at 1024px

second paragraph: the sticky header covers row one when you scroll

<details>
<summary>element data</summary>

```json
{
  "text": "feature free",
  "selector": "table.compare",
  "xpath": "/html/body/main/table",
  "html": "<table class=\"compare\"><thead><tr><th>feature</th><th>free</th><th class=\"hi…",
  "page_url": "https://www.example.com/pricing",
  "note": "the comparison table overflows at 1024px\n\nsecond paragraph: the sticky header covers row one when you scroll",
  "id": 3,
  "normalised_url": "https://example.com/pricing",
  "page_title": "pricing — example",
  "created_at": "2026-09-20T10:17:45.000Z",
  "selection_rect": {
    "x": 40.5,
    "y": 2200,
    "width": 1200,
    "height": 900.25
  },
  "viewport": {
    "width": 1280,
    "height": 720
  },
  "dpr": 1.5,
  "contained_elements": [
    {
      "tag": "th",
      "text": "feature"
    },
    {
      "tag": "th",
      "text": "free"
    },
    {
      "tag": "th",
      "text": "team"
    }
  ],
  "area_text": "feature free team unlimited boards 3 unlimited"
}
```

</details>

## page "https://example.com/docs/getting-started"

### feedback 2

![feedback 2](screenshots/2.png)

**note:** (none)

<details>
<summary>element data</summary>

```json
{
  "text": "docs & setup: getting started",
  "selector": "h1",
  "xpath": "/html/body/article/h1",
  "html": "<h1>docs &amp; setup: getting started</h1>",
  "page_url": "https://example.com/docs/getting-started#install",
  "note": "",
  "id": 2,
  "normalised_url": "https://example.com/docs/getting-started",
  "page_title": "docs: getting started",
  "created_at": "2026-09-20T10:16:02.000Z",
  "selection_rect": {
    "x": 0,
    "y": 0,
    "width": 640,
    "height": 48
  },
  "viewport": {
    "width": 1280,
    "height": 720
  },
  "dpr": 1,
  "contained_elements": [],
  "area_text": "docs & setup: getting started"
}
```

</details>
