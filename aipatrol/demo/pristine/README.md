# logtool

A small command-line tool for summarising web-server access logs.

## Usage

```
logtool access.log
logtool access.log --top 5
```

It prints how many requests each status code accounted for, and the paths
that were hit most often.

## Development

```
pytest
```
