from pathlib import Path
for name in ['tests/app.test.js', 'output/.qa/check-app.cjs']:
    path = Path(name)
    text = path.read_text(encoding='utf-8').replace('确认扣款并记欠款', '确认并记欠款')
    if name.endswith('check-app.cjs'):
        text = text.replace("debt-confirmation-320.png', fullPage: true", "debt-confirmation-320.png', fullPage: false")
        text = text.replace("debt-detail-320.png', fullPage: true", "debt-detail-320.png', fullPage: false")
        text = text.replace("repayment-confirmation-320.png', fullPage: true", "repayment-confirmation-320.png', fullPage: false")
    path.write_text(text, encoding='utf-8', newline='\n')
