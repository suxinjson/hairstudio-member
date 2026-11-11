# Android 原生菜单与弹窗背景

## 修复原因与范围

启动主题原先将 `@drawable/splash` 设置为全局 `android:background`。该属性会成为主题内 View 的默认背景；Activity 后续切换主题也可能保留未覆盖的属性，导致输入框长按菜单、原生列表或确认框把启动图片铺开。仅修改 `colorBackgroundFloating` 不能清除这个背景。

启动屏现在只使用 AndroidX SplashScreen 专用属性，`MainActivity` 在 `super.onCreate` 前调用 `SplashScreen.installSplashScreen`，及时应用运行主题。应用与 Activity 共用的运行主题明确将 View 默认背景设为透明，不再引用启动图或图标。

应用可控制的原生菜单使用无图片的圆角半透明面板，面板外部与圆角透明，保留清晰的文字、按压反馈和紧凑的内容范围。框架与 AppCompat 两套弹窗主题均覆盖，包含原生确认框、列表、PopupWindow、下拉菜单与操作模式背景。WebView 浮动文本工具栏保留系统布局，通过清洁的宿主主题与浮层颜色消除启动图片继承；不同 WebView/厂商可能使用自己的工具栏实现。

权限授权、文件选择、系统分享面板与安装器由其他系统组件或应用绘制，项目不会给其传入背景图片，也无法替换其主题。其正常的图标预览或白色内容卡片与本次图片铺满的缺陷不同。

## 自动化设备回归

安装 Java 21、Android SDK 35 并连接测试设备后，在根目录运行 `npm run build`，然后执行：

```powershell
cd android
.\gradlew.bat connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.hairstudio.memberapp.NativeThemeTest
```

测试覆盖启动到运行的主题叠加、冷启动/重建/返回前台后的 Activity/Application/WebView 主题、框架和 AppCompat 菜单、PopupWindow、操作模式，以及实际打开的框架和 AppCompat 对话框。将背景绘制到位图，核对圆角外部透明、内容半透明及颜色一致，避免仅比较主题名称而漏掉图片继承。

发布工作流同时执行 `assembleDebugAndroidTest`，确保设备测试代码可编译；此步骤仅编译测试包，不等于在设备上执行测试，也不会上传 debug 安装包作为发布产物。

## 真机逐项检查

| 入口 | 操作与预期 |
| --- | --- |
| 客户搜索、新建/编辑会员、备注与消费说明 | 长按已有文字；检查复制、剪切、粘贴、全选及更多菜单。工具栏紧凑、文字清晰，四周不出现拉伸图标或大片矩形背景。 |
| 登录密码及天猫精灵密钥输入框 | 长按并切换输入法；遵循系统对密码复制的限制，菜单背景无启动图片。 |
| 店员权限、语音音色等下拉选择 | 打开、滚动并取消选项，列表背景无图标、无多余大白块。 |
| 原生网页确认框 | 验证备用 `window.confirm`；标题、内容和确认/取消可读，圆角外部透明。 |
| 备份导入文件选择器 | 打开并返回；系统选择器可正常使用，返回后长按菜单不带启动图片。 |
| 备份分享、复制提示 | 调出系统分享面板并取消；应用图标只在系统指定的位置显示，不铺成背景。 |
| 更新安装、安装来源授权 | 打开系统授权/安装界面再返回，菜单样式不恢复成启动图。 |
| 冷启动、后台返回、横竖屏、浅色/深色系统、老人模式 | 重复上述菜单检查；主页面字号和系统栏安全区保持可用。 |

至少在原问题手机及 Android 8、12、15 的可用设备/模拟器上验收，并记录系统与 WebView 版本。CSS 或桌面浏览器截图不能证明 Android 原生菜单外观已通过。本机未配置 Android SDK/JDK 21 或连接手机，设备测试尚未执行，需重新构建 APK 后验证。
