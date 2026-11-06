"""Shared exact product-type labels; no wildcard inference from generic names."""
import re
import unicodedata

MAX_PRODUCT_TYPES = 300
PRODUCT_TYPE_PATTERN = re.compile(r'[A-Z0-9_]{1,100}')

# These are local search aids, not Amazon's authoritative category taxonomy.
FAMILIES = [
    ('电热水壶', ['电热水壶', '电水壶', '烧水壶', 'electric kettle']),
    ('手机壳', ['手机壳', '手机保护壳', '手机保护套', '手机套', 'phone case', 'cellular phone case', 'phone cases', 'mobile phone cover', 'smartphone case']),
    ('手机支架', ['手机支架', 'phone stand', 'phone holder']),
    ('数据线', ['数据线', '充电线', 'usb cable', 'charging cable']),
    ('充电器', ['充电器', '电源适配器', 'charger', 'power adapter']),
    ('耳机', ['耳机', 'headphone', 'earphone', 'earbud']),
    ('保温杯', ['保温杯', '保温水杯', 'insulated tumbler', 'vacuum flask']),
    ('收纳盒', ['收纳盒', 'storage box', 'storage organizer']),
    ('床单', ['床单', 'bed sheet', 'bedsheet']),
    ('毛巾', ['毛巾', 'towel']),
    ('背包', ['背包', '双肩包', 'backpack']),
    ('行李箱', ['行李箱', '拉杆箱', '旅行箱', '登机箱', '旅行拉杆箱', '行李箱套装', '拉杆箱套装', 'suitcase', 'suitcases', 'luggage', 'luggage set', 'luggage sets', 'trolley case', 'trolley cases', 'carry on suitcase', 'carry-on luggage']),
    ('项链', ['项链', 'necklace']),
    ('耳环', ['耳环', 'earring']),
    ('手链', ['手链', 'bracelet']),
    ('洗发水', ['洗发水', '洗发露', 'shampoo']),
    ('台灯', ['台灯', 'desk lamp', 'table lamp']),
    ('电风扇', ['电风扇', 'electric fan']),
]


def norm(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', str(value)).casefold() if c.isalnum())

_CATEGORY_KEYS = {}
for _label, _aliases in FAMILIES:
    for _alias in [_label] + _aliases:
        _CATEGORY_KEYS.setdefault(norm(_alias), _label)


def canonical_category(value):
    """Exact local synonyms only; broad categories and substring guesses are excluded."""
    return _CATEGORY_KEYS.get(norm(value))


def declared_types(template):
    raw = template.get('product_types')
    if raw is None:
        info = template.get('metadata') or {}
        raw = info.get('product_types', []) if isinstance(info, dict) else []
    if not isinstance(raw, list):
        return []
    return list(dict.fromkeys(p for p in raw if isinstance(p, str) and PRODUCT_TYPE_PATTERN.fullmatch(p)))[:MAX_PRODUCT_TYPES]


def type_labels(template, resolver=None):
    canonical = resolver.canonical if resolver else canonical_category
    return {code: canonical(code) or code for code in declared_types(template)}


class CategoryResolver:
    """A request's immutable team rules, layered over the built-in dictionary."""
    def __init__(self, rows=()):
        self.rules = {norm(r['alias']): dict(r) for r in rows}
        self.targets = {norm(r['category']): r['category'] for r in rows}
        patterns = {}
        for row in self.rules.values():
            word = unicodedata.normalize('NFKC', row['alias']).casefold()
            patterns[word] = row['category']
        for category in self.targets.values():
            patterns.setdefault(unicodedata.normalize('NFKC', category).casefold(), category)
        self.words = patterns
        self.pattern = re.compile('|'.join(
            (r'(?<![a-z0-9])' + re.escape(w) + r'(?![a-z0-9])') if w.isascii() else re.escape(w)
            for w in sorted(patterns, key=len, reverse=True))) if patterns else None

    def canonical(self, value):
        key = norm(value)
        rule = self.rules.get(key)
        return canonical_category(value) or (rule['category'] if rule else self.targets.get(key))

    def exact_alias(self, value):
        key = norm(value)
        return self.rules.get(key) or ({'alias': self.targets[key], 'category': self.targets[key]} if key in self.targets else None)

    def hits(self, text):
        folded = unicodedata.normalize('NFKC', text).casefold()
        return [(self.words[m.group()], m.group()) for m in self.pattern.finditer(folded)] if self.pattern else []
