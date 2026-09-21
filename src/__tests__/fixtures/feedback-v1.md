<!-- annotator-schema-version: 1 -->

## https://example.com/pricing

### item 1

![](screenshots/1.png)

the "start trial" cta is misaligned on mobile

```yaml
id: 1
page_url: https://www.example.com/pricing?plan=team
normalised_url: https://example.com/pricing
created_at: '2026-09-20T10:15:30.000Z'
selection_rect:
  x: 412
  'y': 1188
  width: 267
  height: 100
viewport:
  width: 1280
  height: 720
dpr: 2
context:
  primary_target:
    css_selector: section.plans > div:nth-of-type(2) > a.btn
    xpath: /html/body/main/section[2]/div[2]/a
    outer_html_snippet: <a class="btn btn-primary css-1k2j3h" href="/signup?plan=team" data-track="cta-team">start trial</a>
    truncated: false
  contained_elements:
    - tag: a
      classes:
        semantic:
          - btn
          - btn-primary
        generated:
          - css-1k2j3h
      attrs:
        href: /signup?plan=team
        data-track: cta-team
      text: start trial
    - tag: span
      id: price-team
      text: $12 / seat
  area_text: team $12 / seat start trial
  page_meta:
    url: https://www.example.com/pricing?plan=team
    normalised_url: https://example.com/pricing
    title: pricing — example
    viewport:
      width: 1280
      height: 720
    dpr: 2
    selection_rect:
      x: 412
      'y': 1188
      width: 267
      height: 100
    captured_at: '2026-09-20T10:15:30.000Z'
```

### item 3

![](screenshots/3.png)

the comparison table overflows at 1024px

second paragraph: the sticky header covers row one when you scroll

```yaml
id: 3
page_url: https://www.example.com/pricing
normalised_url: https://example.com/pricing
created_at: '2026-09-20T10:17:45.000Z'
selection_rect:
  x: 40.5
  'y': 2200
  width: 1200
  height: 900
viewport:
  width: 1280
  height: 720
dpr: 1.5
context:
  primary_target:
    css_selector: table.compare
    xpath: /html/body/main/table
    outer_html_snippet: <table class="compare"><thead><tr><th>feature</th><th>free</th><th>team</th>...[truncated]
    truncated: true
  contained_elements:
    - tag: th
      text: feature
    - tag: th
      text: free
    - tag: th
      text: team
  area_text: feature free team unlimited boards 3 unlimited
  page_meta:
    url: https://www.example.com/pricing
    normalised_url: https://example.com/pricing
    title: pricing — example
    viewport:
      width: 1280
      height: 720
    dpr: 1.5
    selection_rect:
      x: 40.5
      'y': 2200
      width: 1200
      height: 900
    captured_at: '2026-09-20T10:17:45.000Z'
  contained_elements_truncated: true
```

## https://example.com/docs/getting-started

### item 2

![](screenshots/2.png)



```yaml
id: 2
page_url: https://example.com/docs/getting-started#install
normalised_url: https://example.com/docs/getting-started
created_at: '2026-09-20T10:16:02.000Z'
selection_rect:
  x: 0
  'y': 0
  width: 640
  height: 48
viewport:
  width: 1280
  height: 720
dpr: 1
context:
  primary_target:
    css_selector: h1
    xpath: /html/body/article/h1
    outer_html_snippet: '<h1>docs: getting started</h1>'
    truncated: false
  contained_elements: []
  area_text: 'docs: getting started'
  page_meta:
    url: https://example.com/docs/getting-started#install
    normalised_url: https://example.com/docs/getting-started
    title: 'docs: getting started'
    viewport:
      width: 1280
      height: 720
    dpr: 1
    selection_rect:
      x: 0
      'y': 0
      width: 640
      height: 48
    captured_at: '2026-09-20T10:16:02.000Z'
```
