# Формат проекта `*.openbench.json` (schemaVersion 1)

Машиночитаемая схема: [project.schema.json](project.schema.json) (генерируется из
`packages/core/src/schema.ts`). Пример: [examples/and-test.openbench.json](../examples/and-test.openbench.json).

```jsonc
{
  "schemaVersion": 1,            // обязательно 1
  "id": "project",
  "title": "Лабораторная 1: элемент И",
  "components": [
    { "id": "wg",   "type": "WORD_GENERATOR", "x": 40,  "y": 20 },
    { "id": "and1", "type": "AND",            "x": 140, "y": 120 },
    { "id": "in1",  "type": "INPUT", "x": 0, "y": 0, "value": 1, "key": "1", "label": "a0" }
  ],
  "junctions": [ { "id": "j1", "x": 100, "y": 10 } ],
  "wires": [
    { "id": "w1", "a": "wg.D0", "b": "and1.A" },
    { "id": "w2", "a": "in1.OUT", "b": "j1", "points": [ { "x": 60, "y": 10 } ] }
  ],
  "instruments": {
    "wordGenerator": { "words": [0, 1, 2, 3], "cycle": false, "stepsPerSecond": 4 },
    "logicAnalyzer": {
      "channels": [ { "label": "CH0", "visible": true } /* … ровно 16 … */ ],
      "maxHistory": 10000,
      "clocksPerDivision": 1
    }
  },
  "viewport": { "x": 20, "y": 20, "zoom": 1.5 }   // необязательно
}
```

## Компоненты и выводы

Координаты (`x`, `y`) — левый верхний угол в единицах холста (сетка 10).

| `type` | Выводы | Примечание |
|---|---|---|
| `INPUT` | `OUT` | ручной переключатель; `value` 0/1, `key` — клавиша-переключатель |
| `OUTPUT` | `IN` | пробник |
| `CONST0`, `CONST1` | `OUT` | земля / +Vcc |
| `BUFFER`, `NOT` | `A`, `OUT` | |
| `AND`, `NAND`, `OR`, `NOR`, `XOR`, `XNOR` | `A`, `B`, `OUT` | |
| `WORD_GENERATOR` | `D0`…`D15` (выходы) | не больше одного; `D0` — младший бит слова |
| `LOGIC_ANALYZER` | `CH0`…`CH15` (входы) | не больше одного |

ID вывода — `<id компонента>.<имя вывода>`, например `and1.OUT`.

## Провода

* `a`, `b` — ID вывода (содержит точку) или ID узла `junctions` (без точки).
* `points` — необязательные промежуточные вершины. Без них провод трассируется
  автоматически.
* Сеть — все концы, связанные проводами. В одной сети не больше одного выхода.

## Приборы

* `wordGenerator.words` — до 1024 целых 0…65535. Бит *k* слова подаётся на вывод `Dk`.
* `logicAnalyzer.channels` — ровно 16 записей: подпись и видимость. К чему подключён
  канал, определяют провода к выводам `CHk`.
* История анализатора и текущий шаг в файл не сохраняются.
