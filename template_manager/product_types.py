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


def type_labels(template):
    return {code: canonical_category(code) or code for code in declared_types(template)}
